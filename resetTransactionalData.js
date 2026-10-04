require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const Conversion = require('./src/db/models/Conversion');
const Visit = require('./src/db/models/Visit');
const Customer = require('./src/db/models/Customer');
const RawEvent = require('./src/db/models/RawEvent');

const DELETE = process.argv.includes('--delete');

(async () => {
  await connectDB();

  const counts = {
    invoices: await Invoice.countDocuments({}),
    conversions: await Conversion.countDocuments({}),
    visits: await Visit.countDocuments({}),
    customers: await Customer.countDocuments({}),
    rawEvents: await RawEvent.countDocuments({}),
  };

  console.log('Will delete:', counts);
  console.log('Will KEEP: Brand, User, MarketingPlatform (config/credentials untouched)');

  if (!DELETE) {
    console.log('\nDry run only. Re-run with --delete to actually wipe this data.');
    process.exit(0);
  }

  await Invoice.deleteMany({});
  await Conversion.deleteMany({});
  await Visit.deleteMany({});
  await Customer.deleteMany({});
  await RawEvent.deleteMany({});

  console.log('Wiped. Fresh data starts from the next webhook/visit that comes in.');
  process.exit(0);
})();




// node resetTransactionalData.js
// node resetTransactionalData.js --delete