/**
 * Read-only diagnostic: given an email or phone, prints the Customer doc,
 * every Invoice linked to it, and the most recent invoice.closed RawEvents -
 * specifically whether guest.id was present on the payload. Use this to
 * confirm whether a "last purchase not showing" case is a missing
 * customerId link on the invoice vs. something else.
 *
 * Usage: node checkCustomerPurchase.js umb284@hotmail.com
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Customer = require('./src/db/models/Customer');
const Invoice = require('./src/db/models/Invoice');
const RawEvent = require('./src/db/models/RawEvent');

const identifier = process.argv[2];
if (!identifier) {
  console.error('Usage: node checkCustomerPurchase.js <email-or-phone>');
  process.exit(1);
}

async function run() {
  await connectDB();

  const customers = await Customer.find({
    $or: [{ email: identifier }, { phone: identifier }],
  });

  console.log(`\nFound ${customers.length} customer doc(s) matching "${identifier}"`);
  for (const c of customers) {
    console.log('\n--- Customer ---');
    console.log({
      _id: c._id.toString(),
      name: c.name,
      email: c.email,
      phone: c.phone,
      zenotiGuestId: c.zenotiGuestId,
      firstPurchaseDate: c.firstPurchaseDate,
      lastPurchaseDate: c.lastPurchaseDate,
      lifetimeRevenue: c.lifetimeRevenue,
    });

    const invoices = await Invoice.find({ customerId: c._id }).sort({ closedAt: -1 });
    console.log(`  Invoices linked to this customer: ${invoices.length}`);
    for (const inv of invoices) {
      console.log('   ', {
        zenotiInvoiceId: inv.zenotiInvoiceId,
        amount: inv.amount,
        status: inv.status,
        closedAt: inv.closedAt,
      });
    }
  }

  // Check specifically for yesterday's known invoice (from the Zenoti API check).
  const knownInvoice = await Invoice.findOne({ zenotiInvoiceId: 'a576a112-ded7-4233-ba66-038bdda20379' });
  console.log('\n--- Invoice 19061 (a576a112...) in our DB ---');
  console.log(knownInvoice
    ? { customerId: knownInvoice.customerId, amount: knownInvoice.amount, status: knownInvoice.status, closedAt: knownInvoice.closedAt }
    : 'NOT FOUND - this invoice never made it into our Invoice collection at all.');

  // Any invoices with NO customerId at all recently - these are exactly the
  // ones that would silently skip lastPurchaseDate.
  const orphanInvoices = await Invoice.find({ customerId: null }).sort({ closedAt: -1 }).limit(10);
  console.log(`\nMost recent invoices with customerId: null (unlinked) -> ${orphanInvoices.length}`);
  for (const inv of orphanInvoices) {
    console.log('   ', {
      zenotiInvoiceId: inv.zenotiInvoiceId,
      amount: inv.amount,
      closedAt: inv.closedAt,
    });
  }

  // Raw invoice.closed events from the last 3 days - check whether guest.id
  // is actually present in the payload Zenoti is sending.
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const rawEvents = await RawEvent.find({
    source: 'zenoti',
    eventType: 'invoice.closed',
    createdAt: { $gte: since },
  }).sort({ createdAt: -1 });

  console.log(`\nRaw invoice.closed events in last 3 days: ${rawEvents.length}`);
  for (const e of rawEvents) {
    const guest = e.payload?.data?.invoice?.guest || {};
    console.log('   ', {
      createdAt: e.createdAt,
      processed: e.processed,
      invoiceId: e.payload?.data?.invoice?.id,
      'guest.id present?': Boolean(guest.id),
      'guest.guest_email': guest.guest_email,
      'guest.mobile_phone': guest.mobile_phone,
    });
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Check failed:', err);
  process.exit(1);
});