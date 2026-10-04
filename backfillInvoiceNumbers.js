// backfillInvoiceNumbers.js - fills Invoice.invoiceNumber (e.g. "CH18816") from stored raw Zenoti events.
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const RawEvent = require('./src/db/models/RawEvent');

(async () => {
  await connectDB();
  const invoices = await Invoice.find({ $or: [{ invoiceNumber: null }, { invoiceNumber: { $exists: false } }] });
  console.log(`Checking ${invoices.length} invoices for missing invoice numbers...`);

  let fixed = 0;
  for (const invoice of invoices) {
    const event = await RawEvent.findOne({
      source: 'zenoti',
      'payload.data.invoice.id': invoice.zenotiInvoiceId,
    }).sort({ receivedAt: -1 });

    const inv = event?.payload?.data?.invoice;
    if (!inv || !inv.invoice_number) continue;

    invoice.invoiceNumber = `${inv.invoice_number_prefix || ''}${inv.invoice_number}`;
    await invoice.save();
    fixed++;
  }

  console.log(`Backfilled invoice number on ${fixed} of ${invoices.length} invoices.`);
  process.exit(0);
})();