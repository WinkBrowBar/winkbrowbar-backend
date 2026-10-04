require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');

(async () => {
  await connectDB();

  // Original window, but also check a day of padding on each side to catch
  // any invoice sitting right at a timezone-shifted boundary.
  const paddedSince = new Date('2026-08-25T00:00:00Z');
  const paddedUntil = new Date('2026-09-02T23:59:59Z');
  const windowSince = new Date('2026-08-26T00:00:00Z');
  const windowUntil = new Date('2026-09-01T23:59:59Z');

  const edgeInvoices = await Invoice.find({
    status: 'closed',
    closedAt: { $gte: paddedSince, $lte: paddedUntil },
    $or: [
      { closedAt: { $lt: windowSince } },
      { closedAt: { $gt: windowUntil } },
    ],
  }).sort({ closedAt: 1 });

  console.log(`Invoices within 1 day of the window boundary but outside it (UTC-based):`);
  edgeInvoices.forEach((inv) => {
    console.log(`${inv.zenotiInvoiceId} | closedAt (UTC)=${inv.closedAt.toISOString()} | amount=${inv.amount} | exTax=${(inv.amount - (inv.tax||0)).toFixed(2)} | center=${inv.centerName}`);
  });
  console.log(`\n${edgeInvoices.length} invoice(s) found near the boundary.`);
  process.exit(0);
})();
