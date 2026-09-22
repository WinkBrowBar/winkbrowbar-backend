/**
 * Prints the raw Zenoti webhook payload(s) for a given invoice ID (or the
 * most recent invoice.closed events if no ID given), so we can see exactly
 * what shape/value Zenoti is actually sending for is_closed - useful when
 * Invoice.status is unexpectedly stuck as "open" for real, paid invoices.
 *
 * Usage:
 *   node inspectInvoiceRawEvent.js --brand=<brandId>                (latest 5 invoice.closed raw events)
 *   node inspectInvoiceRawEvent.js --brand=<brandId> --invoice=<zenotiInvoiceId>
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const RawEvent = require('./src/db/models/RawEvent');
const Invoice = require('./src/db/models/Invoice');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

async function run() {
  const brandId = argValue('brand');
  const invoiceId = argValue('invoice');

  if (!brandId) {
    console.error('Usage: node inspectInvoiceRawEvent.js --brand=<brandId> [--invoice=<zenotiInvoiceId>]');
    process.exit(1);
  }

  await connectDB();

  let rawEvents;

  if (invoiceId) {
    rawEvents = await RawEvent.find({
      brandId: new mongoose.Types.ObjectId(brandId),
      source: 'zenoti',
      eventType: 'invoice.closed',
      'payload.data.invoice.id': invoiceId,
    }).sort({ receivedAt: -1 }).lean();
  } else {
    // No specific invoice given - grab the raw events behind the 5 most
    // recent "open" Invoice docs, so we see real examples of the problem.
    const recentOpenInvoices = await Invoice.find({
      brandId: new mongoose.Types.ObjectId(brandId),
      status: 'open',
    }).sort({ closedAt: -1 }).limit(5).lean();

    rawEvents = [];
    for (const inv of recentOpenInvoices) {
      const match = await RawEvent.findOne({
        brandId: new mongoose.Types.ObjectId(brandId),
        source: 'zenoti',
        eventType: 'invoice.closed',
        'payload.data.invoice.id': inv.zenotiInvoiceId,
      }).sort({ receivedAt: -1 }).lean();
      if (match) rawEvents.push(match);
    }
  }

  if (rawEvents.length === 0) {
    console.log('No matching RawEvent found. Either the invoice ID is wrong, or these Invoice docs were created before RawEvent logging existed.');
    await mongoose.disconnect();
    return;
  }

  rawEvents.forEach((re, i) => {
    const inv = re.payload?.data?.invoice || {};
    console.log(`\n=== RawEvent ${i + 1} (received ${re.receivedAt}) ===`);
    console.log(`invoice.id:         ${inv.id}`);
    console.log(`invoice.is_closed:  ${JSON.stringify(inv.is_closed)}  (typeof: ${typeof inv.is_closed})`);
    console.log(`invoice.status:     ${JSON.stringify(inv.status)}`);
    console.log(`invoice.invoice_date: ${inv.invoice_date}`);
    console.log('\nFull invoice object from payload:');
    console.log(JSON.stringify(inv, null, 2));
  });

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Inspection failed:', err);
  process.exit(1);
});