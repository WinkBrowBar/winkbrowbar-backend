// reconcileZenotiInvoices.js
//
// Prevents the "webhook never arrived at all" gap - the one failure mode
// reprocessFailedEvents.js CANNOT catch, because when a webhook delivery is
// lost in transit (network blip, brief downtime, Zenoti-side issue), there
// is no RawEvent row to retry: nothing was ever received.
//
// This closes that gap by periodically asking Zenoti's own API directly
// "what sales exist for date range X" and creating anything missing here,
// using the exact same handleEvent() logic the live webhook uses (so
// identity resolution, attribution, everything downstream runs identically
// either way).
//
// CONFIRMED 2026-09-26 against the real API: uses the Sales Accrual Report
// endpoint (POST /v1/reports/sales/accrual_basis/flat_file). This was the
// only endpoint this account's API key is scoped for - /v1/centers and
// /api/v2.0/Invoices/invoices_by_date both returned "Authorization has been
// denied". Also confirmed: the date filter is a top-level {start_date,
// end_date} pair in the POST body - Zenoti's own docs show a nested
// invoice_closed_date field instead, which returned "Something went wrong"
// when tried; top-level start_date/end_date is what actually works.
//
// This endpoint returns one row per LINE ITEM (a service/product sold), not
// one row per invoice, and covers every center this key has access to in a
// single call - no separate per-center loop needed. Rows for the same
// invoice are grouped back together here before being handed to
// handleEvent().
//
// Known limitation: this report does not include guest email/phone, only
// guest_id + guest_name. Identity resolution here falls back to matching by
// zenotiGuestId alone - fine for any guest who already has a Customer
// record from a prior guest.created/updated webhook (the normal case), but
// a guest who has genuinely NEVER triggered any other webhook event will
// get created with a name only, no email/phone, same as the live webhook
// would do with a guest.id-only reference.
//
// Meant to run on a schedule (cron), not just by hand - see the crontab
// line suggested at the end of its output. Safe to re-run: every write is
// either an upsert or a "skip if already present" check, so running this
// every night forever cannot create duplicates or double-count revenue.
//
// Requires (NOT the webhook secret):
//   ZENOTI_API_BASE=https://api.zenoti.com   (or your region's API host)
//   ZENOTI_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//
// Usage:
//   node reconcileZenotiInvoices.js --brand=<brandId or slug>   # rolling 5-day window, applies for real
//   node reconcileZenotiInvoices.js --brand=<...> --days=30     # wider window (e.g. first run, to catch older gaps)
//   node reconcileZenotiInvoices.js --brand=<...> --dry-run     # preview only, writes nothing

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Invoice = require('./src/db/models/Invoice');
const { handleEvent } = require('./src/webhooks/zenotiWebhook');

const DRY_RUN = process.argv.includes('--dry-run');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;
const REPORT_URL = `${ZENOTI_API_BASE}/v1/reports/sales/accrual_basis/flat_file`;

async function fetchAllSalesRows({ startDate, endDate }) {
  const all = [];
  let page = 1;
  const size = 200;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await axios.post(
      REPORT_URL,
      { start_date: startDate, end_date: endDate },
      {
        params: { Page: page, Size: size },
        headers: { Authorization: `apikey ${ZENOTI_API_KEY}`, 'Content-Type': 'application/json' },
      }
    );

    const batch = data.sales || [];
    all.push(...batch);

    const total = data.page_info ? data.page_info.total : batch.length;
    if (all.length >= total || batch.length < size) break;
    page += 1;
  }

  return all;
}

// Groups line-item rows back into one row per invoice, and reshapes into
// the same { event_type, data: { invoice: {...} } } envelope the live
// webhook receives for invoice.closed, so it goes through handleEvent()
// identically - same currency-per-brand, invoiceNumber, everything.
function groupIntoInvoices(rows) {
  const byInvoice = new Map();

  for (const row of rows) {
    const id = row.invoice_id;
    if (!id) continue;
    if (!byInvoice.has(id)) {
      byInvoice.set(id, {
        id,
        invoice_no: row.invoice_no,
        center_id: row.center_id,
        center_name: row.center_name,
        guest_id: row.guest_id,
        guest_name: row.guest_name,
        invoice_date: row.invoice_date || row.sale_date,
        status: row.status,
        items: [],
        sum_total: 0,
        tax: 0,
      });
    }
    const inv = byInvoice.get(id);
    inv.sum_total += Number(row.sales_inc_tax) || 0;
    inv.tax += Number(row.tax) || 0;
    inv.items.push({ name: row.item_name, price: Number(row.price) || 0 });
  }

  return Array.from(byInvoice.values());
}

function toSyntheticEvent(inv) {
  const nameParts = (inv.guest_name || '').trim().split(/\s+/);
  const first_name = nameParts[0] || null;
  const last_name = nameParts.slice(1).join(' ') || null;

  return {
    event_type: 'invoice.closed',
    data: {
      invoice: {
        id: inv.id,
        invoice_number: inv.invoice_no || null,
        invoice_number_prefix: '', // invoice_no from this report already includes any prefix
        is_closed: typeof inv.status === 'string' && inv.status.toLowerCase() === 'closed',
        is_refund: inv.sum_total < 0,
        invoice_date: inv.invoice_date,
        transactions: [], // not available from this report - is_closed comes straight from `status` instead
        total_price: { sum_total: inv.sum_total, tax: inv.tax },
        invoice_items: inv.items.map((it) => ({ name: it.name, price: { final: it.price } })),
        center: { id: inv.center_id, name: inv.center_name },
        center_id: inv.center_id,
        guest: {
          id: inv.guest_id,
          email: null, // not available from this report
          mobile_phone: null,
          first_name,
          last_name,
        },
      },
    },
  };
}

async function run() {
  if (!ZENOTI_API_KEY) {
    console.error('ZENOTI_API_KEY is not set in .env - required to call the Zenoti API directly (this is different from ZENOTI_WEBHOOK_SECRET).');
    process.exit(1);
  }

  const brandArg = argValue('brand');
  const days = Number(argValue('days')) || 5;

  if (!brandArg) {
    console.error('Usage: node reconcileZenotiInvoices.js --brand=<brandId or slug> [--days=5] [--dry-run]');
    process.exit(1);
  }

  await connectDB();

  const brand = mongoose.isValidObjectId(brandArg)
    ? await Brand.findById(brandArg)
    : await Brand.findOne({ slug: brandArg });

  if (!brand) {
    console.error(`No brand found matching "${brandArg}"`);
    process.exit(1);
  }

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  // CONFIRMED format from the real API test: "YYYY-MM-DDTHH:MM:SS"
  const startStr = `${start.toISOString().slice(0, 10)}T00:00:00`;
  const endStr = `${end.toISOString().slice(0, 10)}T23:59:59`;

  console.log(`Brand: ${brand.name} (${brand._id})`);
  console.log(`Window: ${startStr} -> ${endStr} (last ${days} days)`);
  console.log(DRY_RUN ? 'MODE: --dry-run (nothing will be written)\n' : 'MODE: live (writing anything missing)\n');

  let rows;
  try {
    rows = await fetchAllSalesRows({ startDate: startStr, endDate: endStr });
  } catch (err) {
    console.error('Failed to fetch sales accrual report:', err.response ? err.response.data : err.message);
    process.exit(1);
  }

  console.log(`Fetched ${rows.length} line item row(s) from Zenoti.`);

  const invoices = groupIntoInvoices(rows);
  console.log(`Grouped into ${invoices.length} distinct invoice(s).\n`);

  let alreadyHad = 0;
  let created = 0;
  let failed = 0;

  for (const inv of invoices) {
    const existing = await Invoice.findOne({ brandId: brand._id, zenotiInvoiceId: inv.id });
    if (existing) {
      alreadyHad += 1;
      continue; // already synced via webhook - don't double count revenue
    }

    console.log(`MISSING -> invoice ${inv.invoice_no}, amount ${inv.sum_total.toFixed(2)}, status ${inv.status}, date ${inv.invoice_date}, center ${inv.center_name}`);

    if (!DRY_RUN) {
      try {
        await handleEvent(String(brand._id), toSyntheticEvent(inv));
        created += 1;
      } catch (err) {
        console.error(`  -> FAILED to process: ${err.message}`);
        failed += 1;
      }
    } else {
      created += 1;
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Invoices fetched from Zenoti: ${invoices.length}`);
  console.log(`Already present (skipped): ${alreadyHad}`);
  console.log(`Invoices ${DRY_RUN ? 'that WOULD be created' : 'created/processed'}: ${created}`);
  if (failed) console.log(`Failed to process: ${failed}`);

  console.log('\nTo run this automatically every night, add to crontab (2am):');
  console.log(`  0 2 * * * cd ${__dirname} && /usr/bin/node reconcileZenotiInvoices.js --brand=${brand._id} >> reconcile.log 2>&1`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Reconcile failed:', err);
  process.exit(1);
});