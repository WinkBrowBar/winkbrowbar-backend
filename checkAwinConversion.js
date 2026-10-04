require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');

(async () => {
  await connectDB();

  const conversions = await Conversion.find({ platform: 'awin' }).sort({ eventTime: -1 }).limit(10);

  for (const c of conversions) {
    const invoice = await Invoice.findById(c.invoiceId);
    const customer = await Customer.findById(c.customerId);
    console.log(`Conversion ${c._id} | eventTime=${c.eventTime} | amount=${c.amount} | status=${c.status}`);
    console.log(`  Customer: ${customer ? customer.name + ' <' + customer.email + '>' : 'NOT FOUND'}`);
    console.log(`  Invoice items: ${invoice ? JSON.stringify(invoice.items) : 'NOT FOUND'}`);
    console.log('');
  }
  process.exit(0);
})();
