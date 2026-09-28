// checkDuplicateAttribution.js
//
// Hypothesis: some invoices have TWO non-klaviyo Conversion records - an
// older "direct"/organic one (created when the invoice first closed, before
// the real ad-click attribution was found) and a newer "google" one
// (created later by reconcileMisattributedConversions.js). The Transactions
// page's platform FILTER checks "does google exist anywhere for this
// invoice" (finds it correctly), but its DISPLAY column picks whichever
// conversion comes first in an unsorted lookup - which can grab the older
// "direct" one instead, causing the filter and the displayed label to
// disagree, like Rinad Alanakriy's invoice WV25028 just showed.
//
// Read-only. Checks every "google" conversion for a sibling non-klaviyo
// conversion on the same invoice.
//
// Usage:
//   node checkDuplicateAttribution.js

require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');

(async () => {
  await connectDB();

  const googleConversions = await Conversion.find({ platform: 'google', status: 'sent' }).sort({ eventTime: -1 }).lean();

  console.log(`\nChecking ${googleConversions.length} "google" conversions for a conflicting sibling record on the same invoice...\n`);

  let clean = 0;
  let conflicting = 0;

  for (const gc of googleConversions) {
    const siblings = await Conversion.find({
      invoiceId: gc.invoiceId,
      platform: { $ne: 'klaviyo' },
      _id: { $ne: gc._id },
    }).lean();

    if (siblings.length > 0) {
      conflicting++;
      const invoice = await Invoice.findById(gc.invoiceId).lean();
      const customer = await Customer.findById(gc.customerId).lean();
      const label = `${customer ? (customer.name || customer.email) : '(unknown)'} | invoice ${invoice ? (invoice.invoiceNumber || invoice.zenotiInvoiceId) : gc.invoiceId}`;

      console.log(`CONFLICT - ${label}`);
      console.log(`  google conversion: _id ${gc._id} | createdAt ${gc.createdAt ? gc.createdAt.toISOString() : '?'}`);
      for (const s of siblings) {
        console.log(`  sibling "${s.platform}":     _id ${s._id} | createdAt ${s.createdAt ? s.createdAt.toISOString() : '?'} | status ${s.status}`);
      }
      // MongoDB's $lookup with $limit:1 and no $sort returns whichever
      // matches first in natural storage order - which in practice almost
      // always means ascending _id (creation order) for a normal collection.
      const allForThisInvoice = [gc, ...siblings].sort((a, b) => String(a._id).localeCompare(String(b._id)));
      console.log(`  -> Transactions page would likely display: "${allForThisInvoice[0].platform}" (whichever has the smaller/earlier _id)\n`);
    } else {
      clean++;
    }
  }

  console.log(`--- Summary ---`);
  console.log(`Clean (only a "google" record, no conflicting sibling): ${clean}`);
  console.log(`CONFLICTING (also has another non-klaviyo record on the same invoice): ${conflicting}`);
  console.log(`\nDone.`);

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});