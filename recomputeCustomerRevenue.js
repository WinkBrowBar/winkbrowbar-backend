// recomputeCustomerRevenue.js
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');

(async () => {
  await connectDB();

  const customers = await Customer.find({});
  let fixed = 0;

  for (const customer of customers) {
    const invoices = await Invoice.find({ customerId: customer._id, status: 'closed' }).sort({ closedAt: 1 });
    const trueRevenue = invoices.reduce((sum, inv) => sum + Number(inv.amount), 0);
    const trueFirst = invoices[0]?.closedAt || null;
    const trueLast = invoices[invoices.length - 1]?.closedAt || null;

    if (
      Math.abs((customer.lifetimeRevenue || 0) - trueRevenue) > 0.01 ||
      String(customer.firstPurchaseDate) !== String(trueFirst) ||
      String(customer.lastPurchaseDate) !== String(trueLast)
    ) {
      console.log(`${customer.email || customer._id}: lifetimeRevenue ${customer.lifetimeRevenue} -> ${trueRevenue}`);
      customer.lifetimeRevenue = trueRevenue;
      customer.firstPurchaseDate = trueFirst;
      customer.lastPurchaseDate = trueLast;
      await customer.save();
      fixed++;
    }
  }

  console.log(`Fixed ${fixed} of ${customers.length} customers.`);
  process.exit(0);
})();