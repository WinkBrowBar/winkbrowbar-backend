/**
 * Wipes ALL transactional/test data while keeping your credentials intact:
 *   - KEEPS: Brand (brand config), User (logins), MarketingPlatform (API keys)
 *   - WIPES: Customer, Visit, Conversion, Invoice, Appointment, RawEvent
 *
 * This is destructive and irreversible. Take a database backup/snapshot
 * before running --apply, especially if this is a shared or paid Mongo
 * plan with point-in-time recovery available.
 *
 * Usage:
 *   node wipeTransactionalData.js                 (dry run - only counts, no deletes)
 *   node wipeTransactionalData.js --apply          (wipes for ALL brands)
 *   node wipeTransactionalData.js --apply --brand=<brandId>   (wipe one brand only)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');

const Customer = require('./src/db/models/Customer');
const Visit = require('./src/db/models/Visit');
const Conversion = require('./src/db/models/Conversion');
const Invoice = require('./src/db/models/Invoice');
const Appointment = require('./src/db/models/Appointment');
const RawEvent = require('./src/db/models/RawEvent');

const APPLY = process.argv.includes('--apply');
const brandArg = process.argv.find((a) => a.startsWith('--brand='));
const brandId = brandArg ? brandArg.split('=')[1] : null;

const targets = [
  { name: 'Conversion', model: Conversion },
  { name: 'Invoice', model: Invoice },
  { name: 'Appointment', model: Appointment },
  { name: 'Visit', model: Visit },
  { name: 'Customer', model: Customer },
  { name: 'RawEvent', model: RawEvent },
];

async function run() {
  await connectDB();

  const filter = brandId ? { brandId } : {};

  console.log(brandId ? `Scoped to brand: ${brandId}` : 'Scope: ALL brands');
  console.log(APPLY ? 'MODE: --apply (this WILL delete data)\n' : 'MODE: dry run (nothing will be deleted)\n');

  for (const { name, model } of targets) {
    const count = await model.countDocuments(filter);
    console.log(`${name}: ${count} document(s) ${APPLY ? 'to delete' : 'would be deleted'}`);
    if (APPLY && count > 0) {
      const result = await model.deleteMany(filter);
      console.log(`  -> deleted ${result.deletedCount}`);
    }
  }

  console.log('\nKept untouched: Brand, User, MarketingPlatform (your logins and API credentials).');
  if (!APPLY) {
    console.log('\nThis was a dry run. Re-run with --apply to actually delete.');
  } else {
    console.log('\nDone. Database is clean and ready for live testing.');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Wipe failed:', err);
  process.exit(1);
});