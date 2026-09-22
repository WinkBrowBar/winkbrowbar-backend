// reprocessFailedConversions.js
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const { processInvoiceConversion } = require('./src/services/conversionService');

(async () => {
  await connectDB();

  const stuck = await Invoice.find({ status: 'closed', customerId: { $ne: null }, conversionsProcessedAt: null });
  console.log(`Found ${stuck.length} invoices that never completed conversion processing.`);

  let ok = 0, failed = 0;
  for (const inv of stuck) {
    try {
      await processInvoiceConversion({ brandId: inv.brandId, invoiceId: inv._id });
      ok++;
    } catch (err) {
      failed++;
      console.error(`Invoice ${inv._id} still failing: ${err.message}`);
    }
  }
  console.log(`Reprocessed: ${ok} succeeded, ${failed} still failing.`);
  process.exit(0);
})();