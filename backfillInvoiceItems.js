require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const RawEvent = require('./src/db/models/RawEvent');

(async () => {
  await connectDB();

  const invoices = await Invoice.find({ $or: [{ items: { $exists: false } }, { items: { $size: 0 } }] });
  console.log(`Found ${invoices.length} invoices with no items. Backfilling from raw Zenoti payloads...`);

  let fixed = 0;
  for (const invoice of invoices) {
    const event = await RawEvent.findOne({
      source: 'zenoti',
      'payload.data.invoice.id': invoice.zenotiInvoiceId,
    }).sort({ receivedAt: -1 });

    const rawItems = event?.payload?.data?.invoice?.invoice_items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) continue;

    invoice.items = rawItems.map((item) => ({ name: item.name, price: item.price ? item.price.final : 0 }));
    await invoice.save();
    fixed++;
  }

  console.log(`Backfilled ${fixed} of ${invoices.length}. The rest have no matching raw event on file.`);
  process.exit(0);
})();