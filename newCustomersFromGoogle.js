// newCustomersFromGoogle.js
//
// For every "google" conversion, checks whether that invoice was the
// customer's FIRST EVER purchase (new customer) or came after an earlier
// purchase (returning customer) - by comparing the invoice's closedAt
// against Customer.firstPurchaseDate, which conversionService.js sets
// once, the first time a customer's revenue is ever credited.
//
// Read-only.
//
// Usage:
//   node newCustomersFromGoogle.js [days=all]

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

  console.log(`\nChecking ${conversions.length} "google" conversion(s) for new vs returning customer...\n`);

  let newCustomers = 0;
  let returningCustomers = 0;
  let newRevenue = 0;
  let returningRevenue = 0;

  for (const c of conversions) {
    const invoice = await Invoice.findById(c.invoiceId).lean();
    const customer = await Customer.findById(c.customerId).lean();
    const name = customer ? (customer.name || customer.email) : '(unknown)';
    const invNum = invoice ? (invoice.invoiceNumber || invoice.zenotiInvoiceId) : c.invoiceId;

    if (!customer || !invoice) {
      console.log(`${name} | invoice ${invNum} -> UNKNOWN (missing customer or invoice record)`);
      continue;
    }

    // Same-day comparison, since firstPurchaseDate is set from the closedAt
    // of whichever invoice happened to be processed first - exact
    // millisecond match isn't guaranteed, but the calendar day is reliable.
    const invoiceDay = new Date(invoice.closedAt).toISOString().slice(0, 10);
    const firstPurchaseDay = customer.firstPurchaseDate ? new Date(customer.firstPurchaseDate).toISOString().slice(0, 10) : null;
    const isNew = firstPurchaseDay && invoiceDay === firstPurchaseDay;

    if (isNew) {
      newCustomers++;
      newRevenue += Number(c.amount) || 0;
      console.log(`${name.padEnd(28)} | invoice ${String(invNum).padEnd(20)} | $${Number(c.amount).toFixed(2).padStart(8)} | NEW customer`);
    } else {
      returningCustomers++;
      returningRevenue += Number(c.amount) || 0;
      console.log(`${name.padEnd(28)} | invoice ${String(invNum).padEnd(20)} | $${Number(c.amount).toFixed(2).padStart(8)} | returning (first purchase: ${firstPurchaseDay || 'unknown'})`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`New customers from Google:       ${newCustomers}  ($${newRevenue.toFixed(2)})`);
  console.log(`Returning customers from Google:  ${returningCustomers}  ($${returningRevenue.toFixed(2)})`);
  console.log(`\nDone.`);

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});