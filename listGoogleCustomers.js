// listGoogleCustomers.js
//
// Plain, simple listing: every person in the database currently attributed
// to "google" as their acquisition channel. No analysis, just the raw list
// so you can eyeball it directly.
//
// Usage:
//   node listGoogleCustomers.js [days=all]
//   node listGoogleCustomers.js 30
//   node listGoogleCustomers.js         (defaults to all-time)

require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');

const daysArg = process.argv[2];
const days = daysArg ? Number(daysArg) : null;

(async () => {
  await connectDB();

  const match = { platform: 'google', status: 'sent' };
  if (days) {
    match.eventTime = { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  }

  const conversions = await Conversion.find(match).sort({ eventTime: -1 }).lean();

  console.log(`\n${conversions.length} person(s) currently attributed to Google${days ? ` (last ${days} days)` : ' (all time)'}:\n`);

  let totalRevenue = 0;
  let i = 0;
  for (const c of conversions) {
    i += 1;
    const invoice = await Invoice.findById(c.invoiceId).lean();
    const customer = await Customer.findById(c.customerId).lean();
    totalRevenue += Number(c.amount) || 0;

    console.log(
      `${String(i).padStart(3)}. ${(customer ? (customer.name || customer.email) : '(unknown)').padEnd(28)} | ` +
      `invoice ${(invoice ? (invoice.invoiceNumber || invoice.zenotiInvoiceId) : c.invoiceId).toString().padEnd(20)} | ` +
      `$${Number(c.amount).toFixed(2).padStart(8)} | ` +
      `${new Date(c.eventTime).toISOString().slice(0, 10)}`
    );
  }

  console.log(`\nTotal: ${conversions.length} people, $${totalRevenue.toFixed(2)} revenue attributed to Google.`);
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});