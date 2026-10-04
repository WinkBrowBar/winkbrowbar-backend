// verifyGoogleAttributions.js
//
// Independently re-checks every "google" Conversion record against the raw
// underlying data (the actual Visit it was attributed to) - does NOT trust
// the attribution logic's own output, re-derives the verdict from scratch:
//   - Does a real gclid exist on the attributed Visit?
//   - Was that visit captured BEFORE the invoice closed (not after)?
//   - Was it within the brand's attribution window (default 30 days)?
// Flags anything that doesn't hold up as SUSPICIOUS instead of asserting
// everything is fine.
//
// Read-only. Changes nothing.
//
// Usage:
//   node verifyGoogleAttributions.js [days=60]

require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Invoice = require('./src/db/models/Invoice');
const Visit = require('./src/db/models/Visit');
const Customer = require('./src/db/models/Customer');
const Brand = require('./src/db/models/Brand');

const days = Number(process.argv[2]) || 60;

(async () => {
  await connectDB();

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const conversions = await Conversion.find({ platform: 'google', status: 'sent', eventTime: { $gte: since } }).lean();

  console.log(`\nRe-verifying ${conversions.length} "google" conversion(s) from the last ${days} days against raw Visit/gclid data...\n`);

  let ok = 0;
  let suspicious = 0;

  for (const c of conversions) {
    const invoice = await Invoice.findById(c.invoiceId).lean();
    const customer = await Customer.findById(c.customerId).lean();
    const brand = await Brand.findById(c.brandId).lean();
    const windowDays = (brand && brand.attributionWindowDays) || 30;

    const label = `${customer ? (customer.name || customer.email) : '(unknown customer)'} | invoice ${invoice ? (invoice.invoiceNumber || invoice.zenotiInvoiceId) : c.invoiceId} | $${c.amount}`;

    if (!c.attributionVisitId) {
      console.log(`SUSPICIOUS - ${label} - no attributionVisitId stored on the conversion at all`);
      suspicious++;
      continue;
    }

    const visit = await Visit.findById(c.attributionVisitId).lean();
    if (!visit) {
      console.log(`SUSPICIOUS - ${label} - attributionVisitId points to a Visit that no longer exists`);
      suspicious++;
      continue;
    }

    if (!visit.gclid) {
      console.log(`SUSPICIOUS - ${label} - attributed Visit has NO gclid (not actually a Google ad click)`);
      suspicious++;
      continue;
    }

    const eventTime = new Date(c.eventTime);
    const capturedAt = new Date(visit.capturedAt);
    const windowEnd = new Date(capturedAt.getTime() + windowDays * 24 * 60 * 60 * 1000);

    if (capturedAt > eventTime) {
      console.log(`SUSPICIOUS - ${label} - ad click (${capturedAt.toISOString()}) happened AFTER the sale closed (${eventTime.toISOString()}) - backwards, cannot be the real cause`);
      suspicious++;
      continue;
    }

    if (eventTime > windowEnd) {
      console.log(`SUSPICIOUS - ${label} - sale closed ${Math.round((eventTime - capturedAt) / (24 * 60 * 60 * 1000))} days after the click, outside the ${windowDays}-day attribution window`);
      suspicious++;
      continue;
    }

    ok++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`Verified correct (real gclid, real timing, within window): ${ok}`);
  console.log(`Suspicious (flagged above): ${suspicious}`);
  console.log(`\nDone.`);

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});