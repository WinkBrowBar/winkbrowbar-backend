/**
 * One-time reconciliation: finds Invoice docs stuck at status "open" where
 * the guest actually paid in full (Zenoti sent is_closed: false, but the
 * transactions in the raw payload sum to the full invoice amount). Re-runs
 * them through the same effectively-closed logic now live in
 * zenotiWebhook.js, so their Customer stats (lastPurchaseDate,
 * lifetimeRevenue) and platform conversions (Meta/Google/AWIN/Klaviyo)
 * get processed - exactly as if the fix had been live when they first came in.
 *
 * Safe to re-run: Invoice.conversionsProcessedAt already guards against
 * double-processing conversions for the same invoice.
 *
 * Usage:
 *   node reconcileOpenInvoices.js --brand=<brandId>              (dry run - report only)
 *   node reconcileOpenInvoices.js --brand=<brandId> --apply       (fixes them for real)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const RawEvent = require('./src/db/models/RawEvent');
const { handleEvent } = require('./src/webhooks/zenotiWebhook');

const APPLY = process.argv.includes('--apply');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

function isPaidInFull(inv) {
  const transactions = Array.isArray(inv.transactions) ? inv.transactions : [];
  const amountPaid = transactions.reduce((sum, t) => sum + (Number(t.amount_paid) || 0), 0);
  const totalDue = Number(inv.total_price?.sum_total) || 0;
  // Absolute-value comparison so this also catches refunds (negative
  // totalDue/amountPaid), matching the fix now in zenotiWebhook.js.
  return totalDue !== 0 && Math.abs(amountPaid) >= Math.abs(totalDue) - 0.01;
}

async function run() {
  const brandId = argValue('brand');
  if (!brandId) {
    console.error('Usage: node reconcileOpenInvoices.js --brand=<brandId> [--apply]');
    process.exit(1);
  }

  await connectDB();

  console.log(APPLY ? 'MODE: --apply (this WILL update Invoices/Customers/Conversions)\n' : 'MODE: dry run (nothing will be changed)\n');

  const openInvoices = await Invoice.find({
    brandId: new mongoose.Types.ObjectId(brandId),
    status: 'open',
  }).sort({ closedAt: 1 });

  console.log(`Found ${openInvoices.length} invoice(s) with status "open".\n`);

  let paidInFullCount = 0;
  let stillGenuinelyOpen = 0;
  let noRawEvent = 0;
  let processed = 0;
  let failed = 0;

  for (const invoiceDoc of openInvoices) {
    const rawEvent = await RawEvent.findOne({
      brandId,
      source: 'zenoti',
      eventType: 'invoice.closed',
      'payload.data.invoice.id': invoiceDoc.zenotiInvoiceId,
    }).sort({ receivedAt: -1 }); // most recent delivery, in case of retries

    if (!rawEvent) {
      noRawEvent += 1;
      console.log(`Invoice ${invoiceDoc.zenotiInvoiceId}: no matching RawEvent found - skipping.`);
      continue;
    }

    const inv = rawEvent.payload?.data?.invoice || {};

    if (!isPaidInFull(inv)) {
      stillGenuinelyOpen += 1;
      continue; // real business case - guest hasn't paid yet, leave as open
    }

    paidInFullCount += 1;
    console.log(`Invoice ${invoiceDoc.zenotiInvoiceId}: paid in full (amount ${invoiceDoc.amount}, ${invoiceDoc.centerName || 'unknown center'}, ${invoiceDoc.closedAt.toISOString()}) - ${APPLY ? 'reprocessing now' : 'would reprocess'}`);

    if (APPLY) {
      try {
        // Re-run through the exact same handler used by the live webhook,
        // now with the paid-in-full safety net - this updates Invoice.status,
        // Customer.lastPurchaseDate/lifetimeRevenue, and fires conversions.
        await handleEvent(String(brandId), rawEvent.payload);
        processed += 1;
      } catch (err) {
        console.error(`  -> FAILED to reprocess invoice ${invoiceDoc.zenotiInvoiceId}:`, err.message);
        failed += 1;
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Total invoices checked: ${openInvoices.length}`);
  console.log(`No RawEvent found (can't verify): ${noRawEvent}`);
  console.log(`Genuinely still open (not fully paid - left alone): ${stillGenuinelyOpen}`);
  console.log(`Paid in full, ${APPLY ? 'reprocessed' : 'would be reprocessed'}: ${paidInFullCount}`);
  if (failed) console.log(`Failed during reprocessing: ${failed}`);
  if (APPLY) console.log(`Successfully reprocessed: ${processed}`);

  if (!APPLY) {
    console.log('\nThis was a dry run. Re-run with --apply to actually update Invoices/Customers/Conversions.');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Reconciliation failed:', err);
  process.exit(1);
});