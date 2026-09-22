/**
 * One-time backfill: Invoice.isRefund is a new field, only set by
 * zenotiWebhook.js going forward. Any refund invoice that was already
 * processed (closed) before that field existed has isRefund sitting at its
 * schema default (false) forever, even though the original Zenoti payload
 * said is_refund: true. This finds those and corrects the flag from the
 * stored RawEvent - it does NOT touch amount/status/conversions, since
 * those were already handled correctly at the time; only isRefund was
 * missing.
 *
 * Usage:
 *   node backfillInvoiceRefundFlag.js                (dry run - report only)
 *   node backfillInvoiceRefundFlag.js --apply         (fixes ALL brands)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const RawEvent = require('./src/db/models/RawEvent');

const APPLY = process.argv.includes('--apply');

async function run() {
  await connectDB();

  console.log(APPLY ? 'MODE: --apply (this WILL modify data)\n' : 'MODE: dry run (nothing will be changed)\n');

  // Only need to check invoices currently NOT flagged as a refund - true
  // ones were already set correctly by the fixed webhook.
  const candidates = await Invoice.find({
    $or: [{ isRefund: false }, { isRefund: { $exists: false } }],
  });

  console.log(`Checking ${candidates.length} invoice(s) not currently flagged as a refund.\n`);

  let fixed = 0;
  let noRawEvent = 0;
  let alreadyCorrect = 0;

  for (const invoice of candidates) {
    const rawEvent = await RawEvent.findOne({
      source: 'zenoti',
      eventType: 'invoice.closed',
      'payload.data.invoice.id': invoice.zenotiInvoiceId,
    }).sort({ receivedAt: -1 }); // most recent delivery, in case of retries

    if (!rawEvent) {
      noRawEvent += 1;
      continue;
    }

    const inv = rawEvent.payload?.data?.invoice || {};
    const actuallyIsRefund = Boolean(inv.is_refund);

    if (!actuallyIsRefund) {
      alreadyCorrect += 1;
      continue;
    }

    fixed += 1;
    console.log(`Invoice ${invoice.zenotiInvoiceId} (${invoice.centerName || 'unknown center'}, amount ${invoice.amount}): isRefund false -> true`);

    if (APPLY) {
      await Invoice.updateOne({ _id: invoice._id }, { $set: { isRefund: true } });
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Total checked: ${candidates.length}`);
  console.log(`No RawEvent found (can't verify): ${noRawEvent}`);
  console.log(`Already correct (not actually a refund): ${alreadyCorrect}`);
  console.log(`${APPLY ? 'Fixed' : 'Would fix'}: ${fixed}`);

  if (!APPLY) {
    console.log('\nThis was a dry run. Re-run with --apply to actually update these invoices.');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});