require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Invoice = require('./src/db/models/Invoice');
const Visit = require('./src/db/models/Visit');
const Customer = require('./src/db/models/Customer');
const RawEvent = require('./src/db/models/RawEvent');

// Edit this list if you spot more test campaigns/emails later
const TEST_CAMPAIGNS = ['e2e_check', 'meta_structure_check'];
const TEST_EMAILS = [
  'umb284@hotmail.com',
  'backend1@techarchsoftwares.com',
  'test@gmail.com',
  'klaviyotest1@techarchsoftwares.com',
  'klaviyofixtest@techarchsoftwares.com',
  'backend@techarchsoftwares.com',
];
const DELETE = process.argv.includes('--delete');

(async () => {
  await connectDB();

  const testVisits = await Visit.find({ utmCampaign: { $in: TEST_CAMPAIGNS } });
  const visitIds = testVisits.map((v) => v._id);

  const testCustomers = await Customer.find({ email: { $in: TEST_EMAILS } });
  const customerIds = testCustomers.map((c) => c._id);

  const conversions = await Conversion.find({
    $or: [
      { attributionVisitId: { $in: visitIds } },
      { customerId: { $in: customerIds } },
    ],
  });
  const invoiceIds = conversions.map((c) => c.invoiceId);

  console.log(`Found ${conversions.length} conversions, ${visitIds.length} visits, ${invoiceIds.length} invoices, ${customerIds.length} customers to remove:`);
  conversions.forEach((c) => console.log(`  Conversion ${c._id} | platform=${c.platform} | amount=${c.amount}`));

  if (!DELETE) {
    console.log('\nDry run only. Re-run with --delete to actually remove this data.');
    process.exit(0);
  }

  await Conversion.deleteMany({ _id: { $in: conversions.map((c) => c._id) } });
  await Invoice.deleteMany({ _id: { $in: invoiceIds } });
  await Visit.deleteMany({ _id: { $in: visitIds } });
  await Customer.deleteMany({ _id: { $in: customerIds } });
  await RawEvent.deleteMany({ $or: [{ customerId: { $in: customerIds } }, { invoiceId: { $in: invoiceIds } }] });

  console.log('Deleted.');
  process.exit(0);
})();