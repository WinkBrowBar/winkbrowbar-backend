// backfillCustomerType.js
//
// conversionService.js now sets Invoice.customerType going forward, but
// every invoice closed BEFORE that code shipped has customerType: null -
// they'd show "—" in Transactions and never match the New/Returning
// filter. This fills those in using the exact same rule the live code
// uses: per customer, their earliest closed invoice (by closedAt) is
// "new", every later one is "returning".
//
// Only ever writes to invoices where customerType is currently null - will
// never touch one the live webhook already tagged, so it's safe to run
// even after the feature has been live for a while and only catches up
// the backlog.
//
// This is OUR db's view only, same blind spot as the live tag (misses a
// customer whose real first visit predates this tracking system). Run
// reconcileCustomerTypeViaZenoti.js right after this to correct those
// against Zenoti's real 2-year history - that script only touches rows
// tagged "new", so running it after this backfill picks up everything
// this script just set.
//
// Usage:
//   node backfillCustomerType.js --brand=<brandId or slug> [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Invoice = require('./src/db/models/Invoice');

const DRY_RUN = process.argv.includes('--dry-run');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  const brandArg = argValue('brand');
  if (!brandArg) {
    console.error('Usage: node backfillCustomerType.js --brand=<brandId or slug> [--dry-run]');
    process.exit(1);
  }

  await connectDB();

  const brand = mongoose.isValidObjectId(brandArg)
    ? await Brand.findById(brandArg)
    : await Brand.findOne({ slug: brandArg });
  if (!brand) {
    console.error(`No brand found for "${brandArg}"`);
    process.exit(1);
  }

  // Only closed invoices with a known customer and no tag yet.
  const invoices = await Invoice.find({
    brandId: brand._id,
    status: 'closed',
    customerId: { $ne: null },
    customerType: null,
  }).sort({ closedAt: 1 }).lean();

  console.log(`\nFound ${invoices.length} closed, untagged invoice(s) for this brand.\n`);

  const seenCustomer = new Set();
  const ops = [];
  let newCount = 0;
  let returningCount = 0;

  for (const invoice of invoices) {
    const key = String(invoice.customerId);
    const isFirst = !seenCustomer.has(key);
    seenCustomer.add(key);
    const customerType = isFirst ? 'new' : 'returning';
    if (isFirst) newCount++; else returningCount++;

    ops.push({
      updateOne: {
        filter: { _id: invoice._id },
        update: { $set: { customerType } },
      },
    });
  }

  console.log(`Would tag: ${newCount} as "new" (earliest invoice per customer), ${returningCount} as "returning".`);

  if (DRY_RUN) {
    console.log('\nDry run - nothing written. Re-run without --dry-run to apply.');
  } else if (ops.length) {
    const result = await Invoice.bulkWrite(ops);
    console.log(`\nWrote ${result.modifiedCount} update(s).`);
  }

  console.log('\nDone. Run reconcileCustomerTypeViaZenoti.js next to correct any pre-tracking-era "new" tags against Zenoti\'s real history.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});