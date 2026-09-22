/**
 * One-time backfill: pulls invoices directly from the Zenoti API for a date
 * range and replays them through the exact same handleEvent() logic the
 * live webhook uses - identity resolution, Invoice upsert, Customer
 * first/last purchase + lifetimeRevenue update, and conversion attribution
 * (Meta/Google/AWIN/Klaviyo/organic).
 *
 * Why this is needed: between the "empty ping" webhook bug being introduced
 * and the fix being deployed, real Zenoti invoice.closed events were
 * silently discarded before ever being stored - there is no RawEvent to
 * reprocess, so the only way to recover this window is to re-fetch it
 * straight from Zenoti's own API.
 *
 * Requires a Zenoti backend app API key (Admin > Setup > Apps in Zenoti),
 * NOT the webhook secret. Add these to your .env:
 *
 *   ZENOTI_API_BASE=https://api.zenoti.com   (or your region's API host)
 *   ZENOTI_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 * Usage:
 *   node backfillMissedZenotiInvoices.js --brand=<brandId or slug> \
 *        --centers=<centerId1,centerId2> \
 *        --start=2026-08-19 --end=2026-08-22
 *        [--apply]
 *
 *   (no --apply = dry run, just reports what it *would* do)
 *
 * If --centers is omitted, falls back to the brand's zenotiCenterId field.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Invoice = require('./src/db/models/Invoice');
const { handleEvent } = require('./src/webhooks/zenotiWebhook');

const APPLY = process.argv.includes('--apply');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;

async function fetchInvoicesForCenter({ centerId, startDate, endDate }) {
  if (!ZENOTI_API_KEY) {
    throw new Error('ZENOTI_API_KEY is not set in .env - required to call the Zenoti API directly (this is different from ZENOTI_WEBHOOK_SECRET).');
  }

  const all = [];
  let page = 1;
  const pageSize = 100;

  // Zenoti paginates; keep pulling until a short page tells us we're done.
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
// for invoice.closed, so we can hand it straight to the existing
// handleEvent() without duplicating any business logic.
function toSyntheticEvent(rawInvoice, centerId) {
  const guest = rawInvoice.guest || rawInvoice.Guest || {};
  const totalPrice = rawInvoice.total_price || rawInvoice.TotalPrice || {};

  return {
    event_type: 'invoice.closed',
    data: {
      invoice: {
        id: rawInvoice.invoice_id || rawInvoice.id || rawInvoice.InvoiceId,
        is_closed: rawInvoice.status === 'CLOSE' || rawInvoice.status === 'closed' || rawInvoice.is_closed !== false,
        is_refund: Boolean(rawInvoice.is_refund ?? rawInvoice.IsRefund ?? (totalPrice.sum_total ?? totalPrice.SumTotal ?? rawInvoice.sum_total ?? rawInvoice.amount ?? 0) < 0),
        invoice_date: rawInvoice.created_date || rawInvoice.invoice_date || rawInvoice.CreatedDate,
        total_price: {
          sum_total: totalPrice.sum_total ?? totalPrice.SumTotal ?? rawInvoice.sum_total ?? rawInvoice.amount,
        },
        center: { id: centerId, name: rawInvoice.center_name || null },
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
  const brandArg = argValue('brand');
  const centersArg = argValue('centers');
  const startArg = argValue('start');
  const endArg = argValue('end');

  if (!brandArg || !startArg || !endArg) {
    console.error('Usage: node backfillMissedZenotiInvoices.js --brand=<id_or_slug> --start=YYYY-MM-DD --end=YYYY-MM-DD [--centers=id1,id2] [--apply]');
    process.exit(1);
  }

  await connectDB();

  console.log(APPLY ? 'MODE: --apply (this WILL write data)\n' : 'MODE: dry run (nothing will be changed)\n');

  const brand = mongoose.isValidObjectId(brandArg)
    ? await Brand.findById(brandArg)
    : await Brand.findOne({ slug: brandArg });

  if (!brand) {
    console.error(`No brand found matching "${brandArg}"`);
    process.exit(1);
  }

  const centerIds = centersArg
    ? centersArg.split(',').map((c) => c.trim()).filter(Boolean)
    : (brand.zenotiCenterId ? [brand.zenotiCenterId] : []);

  if (centerIds.length === 0) {
    console.error('No center IDs provided and brand has no zenotiCenterId set. Pass --centers=id1,id2 explicitly.');
    process.exit(1);
  }

  console.log(`Brand: ${brand.name} (${brand._id})`);
  console.log(`Centers: ${centerIds.join(', ')}`);
  console.log(`Date range: ${startArg} -> ${endArg}\n`);

  let fetched = 0;
  let alreadyHad = 0;
  let created = 0;
  let failed = 0;

  for (const centerId of centerIds) {
    console.log(`\n--- Fetching invoices for center ${centerId} ---`);
    let rawInvoices;
    try {
      rawInvoices = await fetchInvoicesForCenter({ centerId, startDate: startArg, endDate: endArg });
    } catch (err) {
      console.error(`Failed to fetch invoices for center ${centerId}:`, err.response?.data || err.message);
      continue;
    }

    console.log(`Fetched ${rawInvoices.length} invoice(s) from Zenoti for this center.`);
    fetched += rawInvoices.length;

    for (const raw of rawInvoices) {
      const zenotiInvoiceId = raw.invoice_id || raw.id || raw.InvoiceId;
      if (!zenotiInvoiceId) {
        console.log('Skipping record with no invoice id:', JSON.stringify(raw).slice(0, 200));
        continue;
      }

      const existing = await Invoice.findOne({ brandId: brand._id, zenotiInvoiceId });
      if (existing) {
        alreadyHad += 1;
        continue; // already synced correctly (e.g. via webhook before/after the outage window) - don't double count revenue
      }

      const syntheticEvent = toSyntheticEvent(raw, centerId);
      const guestId = syntheticEvent.data.invoice.guest.id;
      const amount = syntheticEvent.data.invoice.total_price.sum_total;

      console.log(`Invoice ${zenotiInvoiceId}: guest ${guestId || '(none)'}, amount ${amount}, date ${syntheticEvent.data.invoice.invoice_date}`);

      if (APPLY) {
        try {
          await handleEvent(String(brand._id), syntheticEvent);
          created += 1;
        } catch (err) {
          console.error(`  -> FAILED to process invoice ${zenotiInvoiceId}:`, err.message);
          failed += 1;
        }
      } else {
        created += 1; // "would create" in dry run
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Invoices fetched from Zenoti: ${fetched}`);
  console.log(`Already present in DB (skipped, no double-counting): ${alreadyHad}`);
  console.log(`Invoices ${APPLY ? 'created/processed' : 'that WOULD be created'}: ${created}`);
  if (failed) console.log(`Failed to process: ${failed}`);

  if (!APPLY) {
    console.log('\nThis was a dry run. Re-run with --apply to actually write these invoices and update customers/conversions.');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});