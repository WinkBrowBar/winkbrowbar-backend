// verifyGoogleUrls.js
//
// Second, independent verification pass on top of verifyGoogleAttributions.js
// - that script confirmed the gclid field exists and the timing lines up.
// This one prints the actual landing page URL, referrer, and UTM fields for
// each attributed Visit, so you can eyeball whether they genuinely look like
// real Google Ads traffic (e.g. the URL contains a real gclid= parameter,
// utm_source=google, utm_medium=cpc) rather than just trusting the gclid
// field in isolation.
//
// Read-only. Changes nothing.
//
// Usage:
//   node verifyGoogleUrls.js [days=60]

require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Invoice = require('./src/db/models/Invoice');
const Visit = require('./src/db/models/Visit');
const Customer = require('./src/db/models/Customer');

const days = Number(process.argv[2]) || 60;

(async () => {
  await connectDB();

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const conversions = await Conversion.find({ platform: 'google', status: 'sent', eventTime: { $gte: since } })
    .sort({ eventTime: -1 })
    .lean();

  console.log(`\n${conversions.length} "google" conversion(s) - showing the real landing page URL + UTM data behind each one:\n`);

  let hasGclidInUrl = 0;
  let missingGclidInUrl = 0;

  for (const c of conversions) {
    const invoice = await Invoice.findById(c.invoiceId).lean();
    const customer = await Customer.findById(c.customerId).lean();
    const visit = c.attributionVisitId ? await Visit.findById(c.attributionVisitId).lean() : null;

    const label = `${customer ? (customer.name || customer.email) : '(unknown)'} | invoice ${invoice ? (invoice.invoiceNumber || invoice.zenotiInvoiceId) : c.invoiceId}`;

    if (!visit) {
      console.log(`${label} -> NO VISIT RECORD FOUND\n`);
      continue;
    }

    const urlHasGclid = visit.landingPageUrl && /[?&]gclid=/.test(visit.landingPageUrl);
    if (urlHasGclid) hasGclidInUrl++; else missingGclidInUrl++;

    console.log(label);
    console.log(`  landingPageUrl: ${visit.landingPageUrl || '(none stored)'}`);
    console.log(`  referrer:       ${visit.referrer || '(none stored)'}`);
    console.log(`  utmSource:      ${visit.utmSource || '(none)'}  |  utmMedium: ${visit.utmMedium || '(none)'}  |  utmCampaign: ${visit.utmCampaign || '(none)'}`);
    console.log(`  gclid field:    ${visit.gclid ? visit.gclid.slice(0, 25) + '...' : '(none)'}`);
    console.log(`  URL itself contains a gclid= parameter: ${urlHasGclid ? 'YES' : 'no'}`);
    console.log('');
  }

  console.log('--- Summary ---');
  console.log(`Landing page URL itself contains gclid= parameter: ${hasGclidInUrl}`);
  console.log(`Landing page URL does NOT show gclid= (may have been stripped before storing, or gclid came from elsewhere): ${missingGclidInUrl}`);
  console.log('\nDone.');

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});