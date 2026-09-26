// debugMissedConversion.js
// Usage: node debugMissedConversion.js CH19197
//
// Traces one specific invoice through every step conversionService actually
// takes, printing what it finds at each stage - to find exactly where a
// real ad-click visit and a real closed invoice fail to link up.
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');
const Visit = require('./src/db/models/Visit');
const Conversion = require('./src/db/models/Conversion');
const { pickAttributedVisit, platformFromVisit } = require('./src/services/attribution');

const invoiceNumber = process.argv[2];
if (!invoiceNumber) {
  console.log('Usage: node debugMissedConversion.js <invoiceNumber>');
  process.exit(1);
}

(async () => {
  await connectDB();

  const invoice = await Invoice.findOne({ invoiceNumber });
  if (!invoice) {
    console.log(`No invoice found with invoiceNumber "${invoiceNumber}"`);
    process.exit(1);
  }

  console.log('\n=== Invoice ===');
  console.log({
    _id: invoice._id.toString(),
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    customerId: invoice.customerId ? invoice.customerId.toString() : null,
    closedAt: invoice.closedAt,
    conversionsProcessedAt: invoice.conversionsProcessedAt,
    amount: invoice.amount,
  });

  const conversions = await Conversion.find({ invoiceId: invoice._id }).lean();
  console.log('\n=== Existing Conversion docs for this invoice ===');
  console.log(conversions.length ? conversions : '(none - conversion processing never created any record for this invoice)');

  if (!invoice.customerId) {
    console.log('\nSTOP: invoice.customerId is null - this invoice was never linked to a customer, so it could never be attributed to anything. This alone fully explains the miss.');
    process.exit(0);
  }

  const customer = await Customer.findById(invoice.customerId).lean();
  console.log('\n=== Customer on this invoice ===');
  console.log(customer ? { _id: customer._id.toString(), name: customer.name, email: customer.email, phone: customer.phone, zenotiGuestId: customer.zenotiGuestId } : '(customer record missing entirely - dangling reference)');

  // Check for a SEPARATE customer record sharing the same email/phone - if
  // this finds something, it means the Shopify-side identify flow and the
  // Zenoti-side guest record created two different Customer docs for the
  // same real person, and the ad-click Visit is very likely sitting on the
  // OTHER one, invisible to this invoice's customerId.
  if (customer && (customer.email || customer.phone)) {
    const dupes = await Customer.find({
      _id: { $ne: customer._id },
      $or: [
        customer.email ? { email: customer.email } : null,
        customer.phone ? { phone: customer.phone } : null,
      ].filter(Boolean),
    }).lean();
    console.log('\n=== Other Customer records sharing this email/phone ===');
    console.log(dupes.length ? dupes.map((d) => ({ _id: d._id.toString(), name: d.name, email: d.email, phone: d.phone })) : '(none - not a duplicate-customer issue)');

    for (const dupe of dupes) {
      const dupeVisits = await Visit.find({ customerId: dupe._id }).lean();
      console.log(`\n  Visits tied to duplicate customer ${dupe._id}:`, dupeVisits.map((v) => ({ utmSource: v.utmSource, gclid: v.gclid, fbclid: v.fbclid, capturedAt: v.capturedAt })));
    }
  }

  // All visits actually tied to the invoice's own customerId, regardless of
  // click id or window, to see the full picture.
  const allVisits = await Visit.find({ customerId: invoice.customerId }).sort({ capturedAt: 1 }).lean();
  console.log(`\n=== ALL visits tied to invoice.customerId (${allVisits.length}) ===`);
  for (const v of allVisits) {
    console.log({
      capturedAt: v.capturedAt,
      utmSource: v.utmSource,
      gclid: v.gclid,
      fbclid: v.fbclid,
      awinClickId: v.awinClickId,
      withinWindow: invoice.closedAt ? (v.capturedAt >= new Date(invoice.closedAt.getTime() - 30 * 24 * 60 * 60 * 1000) && v.capturedAt <= invoice.closedAt) : 'no closedAt on invoice',
    });
  }

  // Now call the EXACT function conversionService calls, to see precisely
  // what it returns for this real invoice.
  console.log('\n=== Calling pickAttributedVisit exactly as conversionService does ===');
  const { visit, modelUsed } = await pickAttributedVisit({
    brandId: invoice.brandId,
    customerId: invoice.customerId,
    beforeTimestamp: invoice.closedAt,
  });
  console.log('modelUsed:', modelUsed);
  console.log('visit found:', visit ? { capturedAt: visit.capturedAt, gclid: visit.gclid, fbclid: visit.fbclid } : null);
  if (visit) {
    console.log('platformFromVisit result:', platformFromVisit(visit));
  }

  process.exit(0);
})();