require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');

(async () => {
  await connectDB();

  const since = new Date('2026-08-26T00:00:00');
  const until = new Date('2026-09-01T23:59:59');

  const invoices = await Invoice.find({
    status: 'closed',
    closedAt: { $gte: since, $lte: until },
  }).sort({ closedAt: 1 });

  let totalExTax = 0;
  invoices.forEach((inv) => {
    const exTax = (inv.amount || 0) - (inv.tax || 0);
    totalExTax += exTax;
    console.log(`${inv.zenotiInvoiceId || inv._id} | closedAt=${inv.closedAt.toISOString().slice(0,10)} | amount=${inv.amount} | tax=${inv.tax || 0} | exTax=${exTax.toFixed(2)} | centerName=${inv.centerName}`);
  });

  console.log(`\n${invoices.length} invoices, total ex-tax: ${totalExTax.toFixed(2)}`);
  process.exit(0);
})();
