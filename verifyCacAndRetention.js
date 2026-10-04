// verifyCacAndRetention.js
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');
const AdSpend = require('./src/db/models/AdSpend');
const Conversion = require('./src/db/models/Conversion');

(async () => {
  await connectDB();

  // --- Retention (All Time) ---
  const invoices = await Invoice.find({ status: 'closed', customerId: { $ne: null } });
  const perCustomer = {};
  invoices.forEach((inv) => {
    const key = String(inv.customerId);
    perCustomer[key] = (perCustomer[key] || 0) + 1;
  });
  const totalCustomers = Object.keys(perCustomer).length;
  const repeatCustomers = Object.values(perCustomer).filter((c) => c >= 2).length;
  console.log(`Retention (all time): ${repeatCustomers} of ${totalCustomers} customers have 2+ purchases (${((repeatCustomers / totalCustomers) * 100).toFixed(1)}%)`);

  // --- CAC (All Time) ---
  const spend = await AdSpend.aggregate([{ $group: { _id: '$platform', spend: { $sum: '$spend' } } }]);
  for (const s of spend) {
    const newCustomers = await Customer.countDocuments({});
    const platformConversions = await Conversion.find({ platform: s._id, status: 'sent' }).distinct('customerId');
    console.log(`${s._id}: total spend $${s.spend.toFixed(2)}, customers with a ${s._id} conversion: ${platformConversions.length}, naive CAC: $${(s.spend / (platformConversions.length || 1)).toFixed(2)}`);
  }

  process.exit(0);
})();