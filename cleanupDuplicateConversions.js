/**
 * One-time cleanup for data created BEFORE the idempotency fix in
 * conversionService.js / Conversion.js / Invoice.js. That fix stops NEW
 * duplicate conversions from being created, but it doesn't touch duplicates
 * that already exist - and the unique (invoiceId, platform) index in the
 * new Conversion model will refuse to build at all while duplicates exist,
 * so this needs to run before that model is deployed.
 *
 * What this does, in order:
 *
 *   1. DEDUPE CONVERSIONS
 *      Finds every (invoiceId, platform) pair with more than one Conversion
 *      document. For each group, keeps exactly one record (preferring
 *      status "sent" over "failed"/"pending"; ties broken by oldest
 *      createdAt) and deletes the rest. This is what was inflating
 *      "Attributed Revenue" and the byPlatform conversion counts past the
 *      real invoice totals.
 *
 *   2. RECOMPUTE CUSTOMER REVENUE FIELDS FROM SCRATCH
 *      lifetimeRevenue, firstPurchaseDate, and lastPurchaseDate are NOT
 *      patched incrementally here - they're fully recalculated from the
 *      Invoice collection (the source of truth, which was never duplicated
 *      since Invoice upserts are keyed on zenotiInvoiceId). This is safer
 *      than trying to reverse-engineer how many times each customer's
 *      lifetimeRevenue was double-added, since that count isn't reliably
 *      recoverable from the Conversion duplicates alone (e.g. a customer
 *      could have had duplicates on some invoices but not others).
 *
 * Usage:
 *   node cleanupDuplicateConversions.js                 (dry run - report only)
 *   node cleanupDuplicateConversions.js --apply          (fixes ALL brands)
 *   node cleanupDuplicateConversions.js --apply --brand=<brandId>
 *
 * Take a database backup/snapshot before running --apply.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Customer = require('./src/db/models/Customer');
const Invoice = require('./src/db/models/Invoice');

const APPLY = process.argv.includes('--apply');
const brandArg = process.argv.find((a) => a.startsWith('--brand='));
const brandId = brandArg ? brandArg.split('=')[1] : null;

async function dedupeConversions(matchFilter) {
  console.log('--- Step 1: Deduping Conversion records ---\n');

  const duplicateGroups = await Conversion.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: { invoiceId: '$invoiceId', platform: '$platform' },
        count: { $sum: 1 },
        docs: { $push: { id: '$_id', status: '$status', createdAt: '$createdAt', amount: '$amount' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  if (duplicateGroups.length === 0) {
    console.log('No duplicate (invoiceId, platform) conversion pairs found. Nothing to dedupe.\n');
    return { groupsFound: 0, docsDeleted: 0, phantomRevenue: 0 };
  }

  let docsDeleted = 0;
  let phantomRevenue = 0;

  for (const group of duplicateGroups) {
    // Prefer a "sent" record as the survivor; among equal-status records,
    // keep the oldest (the original, before any retry/replay).
    const sorted = [...group.docs].sort((a, b) => {
      if (a.status === 'sent' && b.status !== 'sent') return -1;
      if (b.status === 'sent' && a.status !== 'sent') return 1;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    const [survivor, ...duplicates] = sorted;
    const duplicateIds = duplicates.map((d) => d.id);
    const duplicateAmount = duplicates.reduce((sum, d) => sum + (d.amount || 0), 0);

    console.log(
      `Invoice ${group._id.invoiceId} / ${group._id.platform}: ${group.count} records -> keeping ${survivor.id} (${survivor.status}), ` +
      `deleting ${duplicateIds.length} duplicate(s) worth ${duplicateAmount}`
    );

    if (APPLY) {
      await Conversion.deleteMany({ _id: { $in: duplicateIds } });
    }

    docsDeleted += duplicateIds.length;
    phantomRevenue += duplicateAmount;
  }

  console.log(
    `\n${duplicateGroups.length} duplicate group(s) found, ${docsDeleted} duplicate record(s) ${APPLY ? 'deleted' : 'would be deleted'}, ` +
    `~${phantomRevenue.toFixed(2)} in phantom attributed revenue ${APPLY ? 'removed' : 'would be removed'}.\n`
  );

  return { groupsFound: duplicateGroups.length, docsDeleted, phantomRevenue };
}

async function recomputeCustomerRevenue(customerFilter) {
  console.log('--- Step 2: Recomputing customer lifetimeRevenue / firstPurchaseDate / lastPurchaseDate from Invoice data ---\n');

  const customers = await Customer.find(customerFilter).select('_id lifetimeRevenue firstPurchaseDate lastPurchaseDate');
  let changedCount = 0;

  for (const customer of customers) {
    const stats = await Invoice.aggregate([
      { $match: { customerId: customer._id, status: 'closed' } },
      {
        $group: {
          _id: null,
          lifetimeRevenue: { $sum: '$amount' },
          firstPurchaseDate: { $min: '$closedAt' },
          lastPurchaseDate: { $max: '$closedAt' },
        },
      },
    ]);

    const correct = stats[0] || { lifetimeRevenue: 0, firstPurchaseDate: null, lastPurchaseDate: null };

    const currentRevenue = customer.lifetimeRevenue || 0;
    const revenueDrift = Math.abs(currentRevenue - correct.lifetimeRevenue) > 0.01;
    const firstDrift = String(customer.firstPurchaseDate) !== String(correct.firstPurchaseDate);
    const lastDrift = String(customer.lastPurchaseDate) !== String(correct.lastPurchaseDate);

    if (revenueDrift || firstDrift || lastDrift) {
      changedCount += 1;
      console.log(
        `Customer ${customer._id}: lifetimeRevenue ${currentRevenue} -> ${correct.lifetimeRevenue}` +
        (firstDrift ? `, firstPurchaseDate ${customer.firstPurchaseDate} -> ${correct.firstPurchaseDate}` : '') +
        (lastDrift ? `, lastPurchaseDate ${customer.lastPurchaseDate} -> ${correct.lastPurchaseDate}` : '')
      );

      if (APPLY) {
        await Customer.updateOne(
          { _id: customer._id },
          {
            $set: {
              lifetimeRevenue: correct.lifetimeRevenue,
              firstPurchaseDate: correct.firstPurchaseDate,
              lastPurchaseDate: correct.lastPurchaseDate,
            },
          }
        );
      }
    }
  }

  console.log(`\n${changedCount} of ${customers.length} customer record(s) ${APPLY ? 'corrected' : 'would be corrected'}.\n`);
  return { customersChecked: customers.length, customersChanged: changedCount };
}

async function run() {
  await connectDB();

  const conversionFilter = brandId ? { brandId: new mongoose.Types.ObjectId(brandId) } : {};
  const customerFilter = brandId ? { brandId } : {};

  console.log(brandId ? `Scoped to brand: ${brandId}` : 'Scope: ALL brands');
  console.log(APPLY ? 'MODE: --apply (this WILL modify data)\n' : 'MODE: dry run (nothing will be changed)\n');

  const conversionResult = await dedupeConversions(conversionFilter);
  const customerResult = await recomputeCustomerRevenue(customerFilter);

  console.log('--- Summary ---');
  console.log(`Duplicate conversion groups: ${conversionResult.groupsFound}`);
  console.log(`Duplicate conversion records ${APPLY ? 'deleted' : 'to delete'}: ${conversionResult.docsDeleted}`);
  console.log(`Phantom attributed revenue ${APPLY ? 'removed' : 'to remove'}: ~${conversionResult.phantomRevenue.toFixed(2)}`);
  console.log(`Customer records ${APPLY ? 'corrected' : 'to correct'}: ${customerResult.customersChanged} of ${customerResult.customersChecked}`);

  if (!APPLY) {
    console.log('\nThis was a dry run. Review the output above, then re-run with --apply to actually fix the data.');
    console.log('Do this BEFORE deploying the new Conversion.js model - its unique index will fail to build while duplicates exist.');
  } else {
    console.log('\nDone. Attributed Revenue should now be <= Total Revenue, and customer revenue fields are accurate.');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});