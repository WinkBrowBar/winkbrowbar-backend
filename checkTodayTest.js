require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const Conversion = require('./src/db/models/Conversion');
const Customer = require('./src/db/models/Customer');

(async () => {
  await connectDB();
  const customer = await Customer.findOne({ email: 'umb284@hotmail.com' });
  console.log('Customer:', customer ? customer._id : 'NOT FOUND');

  const invoices = await Invoice.find({ customerId: customer._id }).sort({ closedAt: -1 });
  invoices.forEach((inv) => {
    console.log(`\nInvoice ${inv._id} | closedAt=${inv.closedAt} | status=${inv.status} | items=${JSON.stringify(inv.items)} | brandId=${inv.brandId}`);
  });

  const conversions = await Conversion.find({ customerId: customer._id }).sort({ eventTime: -1 });
  conversions.forEach((c) => {
    console.log(`\nConversion ${c._id} | platform=${c.platform} | status=${c.status} | eventTime=${c.eventTime} | invoiceId=${c.invoiceId} | brandId=${c.brandId}`);
  });

  process.exit(0);
})();