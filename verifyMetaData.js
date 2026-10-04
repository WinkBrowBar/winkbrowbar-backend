// verifyMetaData.js
//
// Same verification as we ran for Google, but for "meta" conversions:
// lists every one, and independently re-derives whether the attribution is
// real by checking the actual Visit's fbclid, landing page URL, referrer,
// and click-before-payment timing - not just trusting the platform field.
//
// Read-only.
//
// Usage:
//   node verifyMetaData.js [days=all]

require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');
const Visit = require('./src/db/models/Visit');

const daysArg = process.argv[2];
const days = daysArg ? Number(daysArg) : null;

function fmt(d) {
  if (!d) return '(none)';
  return new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

(async () => {
  await connectDB();

  const match = { platform: 'meta', status: 'sent' };
  if (days) {
    match.eventTime = { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  }

  const conversions = await Conversion.find(match).sort({ eventTime: -1 }).lean();

  console.log(`\n${conversions.length} "meta" conversion(s)${days ? ` (last ${days} days)` : ' (all time)'}:\n`);

  let ok = 0;
  let suspicious = 0;

  for (const c of conversions) {
    const invoice = await Invoice.findById(c.invoiceId).lean();
    const customer = await Customer.findById(c.customerId).lean();
    const visit = c.attributionVisitId ? await Visit.findById(c.attributionVisitId).lean() : null;

    const name = customer ? (customer.name || customer.email) : '(unknown)';
    const invNum = invoice ? (invoice.invoiceNumber || invoice.zenotiInvoiceId) : c.invoiceId;

    console.log(`${name} | invoice ${invNum} | $${c.amount}`);
    console.log(`   platformResponse note: ${c.platformResponse && c.platformResponse.note ? c.platformResponse.note : '(real external send - has platformResponse: ' + JSON.stringify(c.platformResponse) + ')'}`);

    if (!visit) {
      console.log(`   NO VISIT RECORD - cannot verify\n`);
      suspicious++;
      continue;
    }

    const urlHasFbclid = visit.landingPageUrl && /[?&]fbclid=/.test(visit.landingPageUrl);
    const clickAt = visit.capturedAt;
    const payAt = c.eventTime;
    const deltaHours = clickAt ? Math.round((new Date(payAt) - new Date(clickAt)) / (60 * 60 * 1000)) : null;

    console.log(`   fbclid field:    ${visit.fbclid ? visit.fbclid.slice(0, 25) + '...' : '(NONE)'}`);
    console.log(`   landingPageUrl:  ${visit.landingPageUrl || '(none stored)'}`);
    console.log(`   URL contains fbclid=: ${urlHasFbclid ? 'YES' : 'no'}`);
    console.log(`   referrer:        ${visit.referrer || '(none stored)'}`);
    console.log(`   ad click:        ${fmt(clickAt)}`);
    console.log(`   payment:         ${fmt(payAt)}`);
    console.log(`   gap:             ${deltaHours !== null ? `${deltaHours} hour(s)` : '(n/a)'}`);

    if (visit.fbclid && urlHasFbclid && clickAt && new Date(clickAt) <= new Date(payAt)) {
      console.log(`   VERDICT: OK - real fbclid, real URL, click before payment\n`);
      ok++;
    } else {
      console.log(`   VERDICT: SUSPICIOUS - missing/inconsistent data\n`);
      suspicious++;
    }
  }

  console.log(`--- Summary ---`);
  console.log(`Verified OK: ${ok}`);
  console.log(`Suspicious: ${suspicious}`);
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});