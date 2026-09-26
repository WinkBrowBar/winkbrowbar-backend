// reconcileZenotiInvoices.js
//
// Prevents the "webhook never arrived at all" gap - the one failure mode
// reprocessFailedEvents.js CANNOT catch, because when a webhook delivery is
// lost in transit (network blip, brief downtime, Zenoti-side issue), there
// is no RawEvent row to retry: nothing was ever received.
//
// This closes that gap by periodically asking Zenoti's own API directly
// "what closed invoices exist for center X between date A and B" and
// creating anything missing here, using the exact same handleEvent() logic
// the live webhook uses (so identity resolution, attribution, everything
// downstream runs identically either way).
//
// Meant to run on a schedule (cron), not just by hand - see the crontab
// line suggested at the end of its output. Safe to re-run: every write is
// either an upsert or a "skip if already present" check, so running this
// every night forever cannot create duplicates or double-count revenue.
//
// Requires the same Zenoti API credentials backfillMissedZenotiInvoices.js
// already uses (NOT the webhook secret):
//   ZENOTI_API_BASE=https://api.zenoti.com   (or your region's API host)
//   ZENOTI_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//
// Usage:
//   node reconcileZenotiInvoices.js --brand=<brandId or slug>   # rolling 5-day window, applies for real
//   node reconcileZenotiInvoices.js --brand=<...> --days=14     # wider window (e.g. first run, to catch older gaps)
//   node reconcileZenotiInvoices.js --brand=<...> --dry-run     # preview only, writes nothing
//
// Centers are discovered automatically from the Zenoti API (same call as
// listZenotiCentersFromApi.js) rather than relying on the brand's single
// zenotiCenterId field, since a brand can have more than one location.

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

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchAllCenters() {
  const { data } = await axios.get(`${ZENOTI_API_BASE}/v1/centers`, {
    headers: { Authorization: `apikey ${ZENOTI_API_KEY}` },
  });
  return data.centers || data || [];
}

async function fetchInvoicesForCenter({ centerId, startDate, endDate }) {
  const all = [];
  let page = 1;
  const pageSize = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `${ZENOTI_API_BASE}/api/v2.0/Invoices/invoices_by_date`;
    const { data } = await axios.get(url, {
      headers: { Authorization: `apikey ${ZENOTI_API_KEY}` },
      params: {
        CenterId: centerId,
        StartDate: startDate,
        EndDate: endDate,
        PageNumber: page,
        NumberOfRecords: pageSize,
      },
    });

    const batch = data.invoices || data.Invoices || data.data || [];
    all.push(...batch);

    if (batch.length < pageSize) break;
    page += 1;
  }

  return all;
}

// Reshapes a Zenoti "invoices_by_date" record into the same
// { event_type, data: { invoice: {...} } } shape the live webhook receives
// for invoice.closed, so it goes through handleEvent() identically - same
// invoiceNumber, tax, currency, isPaidInFull-safety-net logic, everything.
function toSyntheticEvent(rawInvoice, centerId, centerNameFromApi) {
  const guest = rawInvoice.guest || rawInvoice.Guest || {};
  const totalPrice = rawInvoice.total_price || rawInvoice.TotalPrice || {};
  const transactions = rawInvoice.transactions || rawInvoice.Transactions || [];

  return {
    event_type: 'invoice.closed',
    data: {
      invoice: {
        id: rawInvoice.invoice_id || rawInvoice.id || rawInvoice.InvoiceId,
        invoice_number: rawInvoice.invoice_number || rawInvoice.InvoiceNumber || null,
        invoice_number_prefix: rawInvoice.invoice_number_prefix || rawInvoice.InvoiceNumberPrefix || '',
        is_closed: rawInvoice.status === 'CLOSE' || rawInvoice.status === 'closed' || rawInvoice.is_closed !== false,
        is_refund: Boolean(rawInvoice.is_refund ?? rawInvoice.IsRefund ?? (totalPrice.sum_total ?? totalPrice.SumTotal ?? rawInvoice.sum_total ?? rawInvoice.amount ?? 0) < 0),
        invoice_date: rawInvoice.created_date || rawInvoice.invoice_date || rawInvoice.CreatedDate,
        transactions,
        total_price: {
          sum_total: totalPrice.sum_total ?? totalPrice.SumTotal ?? rawInvoice.sum_total ?? rawInvoice.amount,
          tax: totalPrice.tax ?? totalPrice.Tax ?? 0,
        },
        invoice_items: (rawInvoice.invoice_items || rawInvoice.InvoiceItems || []).map((item) => ({
          name: item.name || item.Name,
          price: { final: (item.price && (item.price.final ?? item.price.Final)) || item.final_price || 0 },
        })),
        center: { id: centerId, name: centerNameFromApi || rawInvoice.center_name || null },
        center_id: centerId,
        guest: {
          id: guest.id || guest.Id || rawInvoice.guest_id,
          email: guest.email || guest.Email,
          mobile_phone: guest.mobile_phone || guest.Mobile || null,
          first_name: guest.first_name || guest.FirstName,
          last_name: guest.last_name || guest.LastName,
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
  const startStr = toDateStr(start);
  const endStr = toDateStr(end);

  console.log(`Brand: ${brand.name} (${brand._id})`);
  console.log(`Window: ${startStr} -> ${endStr} (last ${days} days)`);
  console.log(DRY_RUN ? 'MODE: --dry-run (nothing will be written)\n' : 'MODE: live (writing anything missing)\n');

  let centers;
  try {
    centers = await fetchAllCenters();
  } catch (err) {
    console.error('Failed to list centers from Zenoti API:', err.response ? err.response.data : err.message);
    process.exit(1);
  }

  if (!centers.length) {
    console.error('Zenoti API returned zero centers - nothing to reconcile against.');
    process.exit(1);
  }

  let fetched = 0;
  let alreadyHad = 0;
  let created = 0;
  let failed = 0;

  for (const c of centers) {
    const centerId = c.id;
    console.log(`\n--- ${c.name || centerId} ---`);
    let rawInvoices;
    try {
      rawInvoices = await fetchInvoicesForCenter({ centerId, startDate: startStr, endDate: endStr });
    } catch (err) {
      console.error(`Failed to fetch invoices for ${c.name || centerId}:`, err.response ? err.response.data : err.message);
      continue;
    }

    console.log(`Fetched ${rawInvoices.length} invoice(s) from Zenoti.`);
    fetched += rawInvoices.length;

    for (const raw of rawInvoices) {
      const zenotiInvoiceId = raw.invoice_id || raw.id || raw.InvoiceId;
      if (!zenotiInvoiceId) continue;

      const existing = await Invoice.findOne({ brandId: brand._id, zenotiInvoiceId });
      if (existing) {
        alreadyHad += 1;
        continue; // already synced via webhook - don't double count revenue
      }

      const syntheticEvent = toSyntheticEvent(raw, centerId, c.name);
      const inv = syntheticEvent.data.invoice;
      console.log(`MISSING -> invoice ${inv.invoice_number_prefix}${inv.invoice_number || inv.id}, amount ${inv.total_price.sum_total}, date ${inv.invoice_date}`);

      if (!DRY_RUN) {
        try {
          await handleEvent(String(brand._id), syntheticEvent);
          created += 1;
        } catch (err) {
          console.error(`  -> FAILED to process: ${err.message}`);
          failed += 1;
        }
      } else {
        created += 1;
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Invoices fetched from Zenoti: ${fetched}`);
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