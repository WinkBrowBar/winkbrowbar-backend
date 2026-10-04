require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Invoice = require('./src/db/models/Invoice');

(async () => {
  await connectDB();
  const conversions = await Conversion.find({ eventTime: { $exists: false } });
  console.log(`Backfilling ${conversions.length} conversions...`);
  for (const c of conversions) {
    const invoice = await Invoice.findById(c.invoiceId);
    c.eventTime = invoice ? invoice.closedAt : c.createdAt;
    await c.save();
  }
  console.log('Done.');
  process.exit(0);
})();