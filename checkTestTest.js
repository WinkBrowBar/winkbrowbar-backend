// checkTestTest.js
//
// User flagged invoice WV25258 (customer "test test", umb284@hotmail.com) -
// our dashboard screenshot shows source "AWIN", but user says this person
// came from Google Ads. Query raw DB records directly to see what's
// actually stored - Visit, Customer, Conversion - before concluding anything.
//
// Read-only.

require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');
const Visit = require('./src/db/models/Visit');

(async () => {
  await connectDB();

  const invoice = await Invoice.findOne({
    $or: [{ invoiceNumber: 'WV25258' }, { zenotiInvoiceId: 'WV25258' }],
  }).lean();

  if (!invoice) {
    console.log('No invoice found for WV25258');
    process.exit(0);
  }
  console.log('INVOICE:', JSON.stringify(invoice, null, 2));

  const customer = await Customer.findById(invoice.customerId).lean();
  console.log('\nCUSTOMER:', JSON.stringify(customer, null, 2));

  const conversions = await Conversion.find({ invoiceId: invoice._id }).lean();
  console.log(`\nCONVERSIONS (${conversions.length}):`, JSON.stringify(conversions, null, 2));

  if (customer) {
    const visits = await Visit.find({ customerId: customer._id }).sort({ capturedAt: 1 }).lean();
    console.log(`\nVISITS for this customer (${visits.length}):`);
    for (const v of visits) {
      console.log(JSON.stringify({
        _id: v._id,
        capturedAt: v.capturedAt,
        landingPageUrl: v.landingPageUrl,
        referrer: v.referrer,
        gclid: v.gclid,
        fbclid: v.fbclid,
        utmSource: v.utmSource,
        utmMedium: v.utmMedium,
        utmCampaign: v.utmCampaign,
      }, null, 2));
    }
  }

  // Also check by email directly, in case customerId linkage is off
  const byEmail = await Customer.findOne({ email: 'umb284@hotmail.com' }).lean();
  if (byEmail && (!customer || String(byEmail._id) !== String(customer._id))) {
    console.log('\nDIFFERENT customer found by email umb284@hotmail.com:', JSON.stringify(byEmail, null, 2));
  }

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});