/**
 * One-time backfill: finds Invoice records with a missing centerId/centerName,
 * looks up their original invoice.closed RawEvent, and re-extracts center_id
 * (and center.name, if ever present) from the raw payload - the same logic
 * zenotiWebhook.js uses today. This fixes historical invoices that were
 * processed before that parsing logic was live in production.
 *
 * Usage:
 *   node backfillInvoiceCenters.js                (dry run - report only)
 *   node backfillInvoiceCenters.js --apply         (fixes ALL brands)
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

  const invoicesToFix = await Invoice.find({
    $or: [{ centerId: null }, { centerId: { $exists: false } }],
  });

  console.log(`Found ${invoicesToFix.length} invoice(s) with missing centerId.\n`);

  let fixed = 0;
  let noRawEvent = 0;
  let noCenter = 0;

  for (const invoice of invoicesToFix) {
    const rawEvent = await RawEvent.findOne({
      source: 'zenoti',
      eventType: 'invoice.closed',
      'payload.data.invoice.id': invoice.zenotiInvoiceId,
    }).sort({ createdAt: -1 }); // most recent delivery, in case of retries

    if (!rawEvent) {
      noRawEvent += 1;
      continue;
    }

    const inv = rawEvent.payload?.data?.invoice || {};
    const center = inv.center || {};
    const centerId = center.id || inv.center_id || null;
    const centerName = center.name || null;

    if (!centerId) {
      noCenter += 1;
      continue;
    }

    console.log(`Invoice ${invoice.zenotiInvoiceId}: centerId null -> ${centerId}${centerName ? `, centerName -> ${centerName}` : ''}`);

    if (APPLY) {
      await Invoice.updateOne(
        { _id: invoice._id },
        { $set: { centerId, centerName } }
      );
    }
    fixed += 1;
  }

  console.log('\n--- Summary ---');
  console.log(`Invoices checked: ${invoicesToFix.length}`);
  console.log(`Invoices ${APPLY ? 'fixed' : 'to fix'}: ${fixed}`);
  console.log(`No matching raw event found: ${noRawEvent}`);
  console.log(`Raw event found but no center_id present: ${noCenter}`);

  if (!APPLY) {
    console.log('\nThis was a dry run. Re-run with --apply to actually fix the data.');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});