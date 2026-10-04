// confirmNewCustomersViaZenoti.js
//
// newCustomersFromGoogle.js labeled 44 of the 60 Google conversions as
// "NEW customer" - but that's based only on OUR database's
// Customer.firstPurchaseDate, which only knows about invoices we've
// actually synced. Zenoti's own history goes back the full 2 years, so a
// customer who bought from you a year ago (before this tracking system
// existed) could show as "new" here even though they're really a repeat
// customer.
//
// This queries Zenoti's real Sales Accrual Report API directly (same
// endpoint/chunking as reconcileZenotiInvoices.js) for up to 2 years back,
// finds the EARLIEST invoice date per guest_id in Zenoti's own records, and
// cross-checks it against each "new" customer's zenotiGuestId - flagging
// anyone where Zenoti shows an earlier purchase than what's in our DB.
//
// Read-only. Makes real API calls to Zenoti (read-only report endpoint),
// writes nothing to Zenoti or to our database.
//
// Usage:
//   node confirmNewCustomersViaZenoti.js [zenotiDaysBack=730]

require('dotenv').config();
const axios = require('axios');
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;
const REPORT_URL = `${ZENOTI_API_BASE}/v1/reports/sales/accrual_basis/flat_file`;
const MAX_CHUNK_DAYS = 350;

async function fetchAllSalesRows({ startDate, endDate }) {
  const all = [];
  let page = 1;
  const size = 200;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await axios.post(
      REPORT_URL,
      { start_date: startDate, end_date: endDate },
      { params: { Page: page, Size: size }, headers: { Authorization: `apikey ${ZENOTI_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    const batch = data.sales || [];
    all.push(...batch);
    const total = data.page_info ? data.page_info.total : batch.length;
    if (all.length >= total || batch.length < size) break;
    page += 1;
  }
  return all;
}

(async () => {
  if (!ZENOTI_API_KEY) {
    console.error('ZENOTI_API_KEY is not set in .env');
    process.exit(1);
  }

  await connectDB();

  const zenotiDaysBack = Number(process.argv[2]) || 730;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - zenotiDaysBack);

  console.log(`\nFetching Zenoti's full sales history for the last ${zenotiDaysBack} days (this may take a minute - chunked into <=${MAX_CHUNK_DAYS}-day windows)...\n`);

  const chunks = [];
  let chunkEnd = new Date(end);
  while (chunkEnd > start) {
    const chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() - MAX_CHUNK_DAYS);
    if (chunkStart < start) chunkStart.setTime(start.getTime());
    chunks.push({ start: new Date(chunkStart), end: new Date(chunkEnd) });
    chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() - 1);
  }

  const earliestByGuestId = new Map(); // guest_id -> earliest invoice_date seen

  for (const [i, chunk] of chunks.entries()) {
    const startStr = `${chunk.start.toISOString().slice(0, 10)}T00:00:00`;
    const endStr = `${chunk.end.toISOString().slice(0, 10)}T23:59:59`;
    console.log(`Fetching chunk ${i + 1}/${chunks.length}: ${startStr} -> ${endStr} ...`);
    const rows = await fetchAllSalesRows({ startDate: startStr, endDate: endStr });
    console.log(`  -> ${rows.length} row(s)`);

    for (const row of rows) {
      const guestId = row.guest_id;
      if (!guestId) continue;
      const invDate = row.invoice_date || row.sale_date;
      if (!invDate) continue;
      const existing = earliestByGuestId.get(guestId);
      if (!existing || new Date(invDate) < new Date(existing)) {
        earliestByGuestId.set(guestId, invDate);
      }
    }
  }

  console.log(`\nBuilt earliest-purchase-date index for ${earliestByGuestId.size} distinct Zenoti guest(s).\n`);

  // Now cross-check every "google" conversion currently labeled NEW by our DB
  const conversions = await Conversion.find({ platform: 'google', status: 'sent' }).sort({ eventTime: -1 }).lean();

  let confirmedNew = 0;
  let actuallyReturning = 0;
  let noZenotiData = 0;

  console.log(`Cross-checking ${conversions.length} Google conversions against Zenoti's real history...\n`);

  for (const c of conversions) {
    const invoice = await Invoice.findById(c.invoiceId).lean();
    const customer = await Customer.findById(c.customerId).lean();
    if (!invoice || !customer) continue;

    const invoiceDay = new Date(invoice.closedAt).toISOString().slice(0, 10);
    const ourFirstPurchaseDay = customer.firstPurchaseDate ? new Date(customer.firstPurchaseDate).toISOString().slice(0, 10) : null;
    const ourLabelIsNew = ourFirstPurchaseDay && invoiceDay === ourFirstPurchaseDay;

    if (!ourLabelIsNew) continue; // only auditing the ones WE currently call "new"

    const name = customer.name || customer.email;
    const invNum = invoice.invoiceNumber || invoice.zenotiInvoiceId;

    if (!customer.zenotiGuestId) {
      console.log(`${name} | invoice ${invNum} -> no zenotiGuestId on file, cannot cross-check`);
      noZenotiData++;
      continue;
    }

    const zenotiEarliest = earliestByGuestId.get(customer.zenotiGuestId);
    if (!zenotiEarliest) {
      console.log(`${name} | invoice ${invNum} -> not found in Zenoti's ${zenotiDaysBack}-day report at all (guest may be genuinely new, or older than the window checked)`);
      noZenotiData++;
      continue;
    }

    const zenotiEarliestDay = new Date(zenotiEarliest).toISOString().slice(0, 10);
    if (zenotiEarliestDay < invoiceDay) {
      console.log(`${name} | invoice ${invNum} -> NOT actually new - Zenoti shows an earlier purchase on ${zenotiEarliestDay}`);
      actuallyReturning++;
    } else {
      console.log(`${name} | invoice ${invNum} -> CONFIRMED new - Zenoti's earliest record for this guest is this same purchase (${zenotiEarliestDay})`);
      confirmedNew++;
    }
  }

  console.log(`\n--- Summary (of the customers OUR db currently calls "new") ---`);
  console.log(`Confirmed genuinely new (Zenoti agrees):      ${confirmedNew}`);
  console.log(`Actually returning (Zenoti shows earlier purchase): ${actuallyReturning}`);
  console.log(`Could not cross-check (no guest id / not in window): ${noZenotiData}`);
  console.log(`\nDone.`);

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});