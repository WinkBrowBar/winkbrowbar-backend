// backfillInvoiceTax.js
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const RawEvent = require('./src/db/models/RawEvent');

(async () => {
  await connectDB();

  const invoices = await Invoice.find({ $or: [{ tax: { $exists: false } }, { tax: 0 }] });
  console.log(`Checking ${invoices.length} invoices for missing tax data...`);

  let fixed = 0;
  for (const invoice of invoices) {
    const event = await RawEvent.findOne({
      source: 'zenoti',
      'payload.data.invoice.id': invoice.zenotiInvoiceId,
    }).sort({ receivedAt: -1 });

    const tax = event?.payload?.data?.invoice?.total_price?.tax;
    if (tax === undefined || tax === null) continue;

    invoice.tax = Number(tax) || 0;
    await invoice.save();
    fixed++;
  }

  console.log(`Backfilled tax on ${fixed} of ${invoices.length} invoices.`);
  process.exit(0);
})();