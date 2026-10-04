// timestampReport.js
//
// For every "google" conversion, shows the actual ad-click timestamp
// (when the visit with the gclid was captured) side by side with the
// actual payment timestamp (when the invoice closed) - so you can
// manually cross-check specific ones against what Google Ads shows in
// its own UI (Recent conversions), instead of trusting a summary number.
//
// Read-only.
//
// Usage:
//   node timestampReport.js [days=all]

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

  const match = { platform: 'google', status: 'sent' };
  if (days) {
    match.eventTime = { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  }

  const conversions = await Conversion.find(match).sort({ eventTime: -1 }).lean();

  console.log(`\n${conversions.length} "google" conversion(s) - ad click time vs payment time:\n`);

  for (const c of conversions) {
    const invoice = await Invoice.findById(c.invoiceId).lean();
    const customer = await Customer.findById(c.customerId).lean();
    const visit = c.attributionVisitId ? await Visit.findById(c.attributionVisitId).lean() : null;

    const name = customer ? (customer.name || customer.email) : '(unknown)';
    const invNum = invoice ? (invoice.invoiceNumber || invoice.zenotiInvoiceId) : c.invoiceId;
    const clickAt = visit ? visit.capturedAt : null;
    const payAt = c.eventTime;
    const deltaHours = clickAt ? Math.round((new Date(payAt) - new Date(clickAt)) / (60 * 60 * 1000)) : null;

    console.log(`${name} | invoice ${invNum} | $${c.amount}`);
    console.log(`   ad click:  ${fmt(clickAt)}`);
    console.log(`   payment:   ${fmt(payAt)}`);
    console.log(`   gap:       ${deltaHours !== null ? `${deltaHours} hour(s) (${(deltaHours / 24).toFixed(1)} days)` : '(no click data)'}`);
    console.log('');
  }

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});