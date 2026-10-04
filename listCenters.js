/**
 * Quick helper: lists every distinct (centerId, centerName) pair already
 * stored on Invoice documents for a brand - so you don't have to go dig
 * through the Zenoti admin UI to find your center IDs for
 * backfillMissedZenotiInvoices.js.
 *
 * Usage:
 *   node listCenters.js --brand=6a61cca755da7f7407aec92e
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

async function run() {
  const brandId = argValue('brand');
  if (!brandId) {
    console.error('Usage: node listCenters.js --brand=<brandId>');
    process.exit(1);
  }

  await connectDB();

  const results = await Invoice.aggregate([
    { $match: { brandId: new mongoose.Types.ObjectId(brandId) } },
    {
      $group: {
        _id: { centerId: '$centerId', centerName: '$centerName' },
        invoiceCount: { $sum: 1 },
        mostRecent: { $max: '$closedAt' },
      },
    },
    { $sort: { invoiceCount: -1 } },
  ]);

  const statusBreakdown = await Invoice.aggregate([
    { $match: { brandId: new mongoose.Types.ObjectId(brandId) } },
    { $sort: { closedAt: -1 } },
    { $limit: 15 },
    { $project: { zenotiInvoiceId: 1, status: 1, closedAt: 1, centerName: 1, amount: 1, conversionsProcessedAt: 1 } },
  ]);

  if (results.length === 0) {
    console.log('No invoices found for this brand - nothing to report.');
  } else {
    console.log(`Found ${results.length} distinct center(s) across this brand's invoices:\n`);
    results.forEach((r) => {
      console.log('---');
      console.log(`centerId:     ${r._id.centerId || '(null - never captured)'}`);
      console.log(`centerName:   ${r._id.centerName || '(unknown)'}`);
      console.log(`invoiceCount: ${r.invoiceCount}`);
      console.log(`mostRecent:   ${r.mostRecent}`);
    });
  }

  const statusCounts = await Invoice.aggregate([
    { $match: { brandId: new mongoose.Types.ObjectId(brandId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const lastClosed = await Invoice.findOne({
    brandId: new mongoose.Types.ObjectId(brandId),
    status: 'closed',
  }).sort({ closedAt: -1 }).lean();

  const firstOpenAfterThat = lastClosed
    ? await Invoice.findOne({
        brandId: new mongoose.Types.ObjectId(brandId),
        status: 'open',
        closedAt: { $gt: lastClosed.closedAt },
      }).sort({ closedAt: 1 }).lean()
    : null;
  console.log('\n--- Overall status breakdown ---\n');
  statusCounts.forEach((s) => console.log(`${s._id}: ${s.count}`));

  console.log('\n--- Cutover point ---\n');
  console.log(`Last invoice that ever reached status "closed": ${lastClosed ? lastClosed.closedAt + ' ($' + lastClosed.amount + ', ' + lastClosed.centerName + ')' : '(none found)'}`);
  console.log(`First "open" invoice after that point: ${firstOpenAfterThat ? firstOpenAfterThat.closedAt + ' ($' + firstOpenAfterThat.amount + ', ' + firstOpenAfterThat.centerName + ')' : '(none found)'}`);

  console.log('\n--- 15 most recent invoices (any center), with status ---\n');
  statusBreakdown.forEach((inv) => {
    console.log(`${inv.closedAt}  |  status: ${inv.status}  |  ${inv.centerName || '(no center)'}  |  $${inv.amount}  |  conversionsProcessedAt: ${inv.conversionsProcessedAt || 'null'}`);
  });

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Failed to list centers:', err);
  process.exit(1);
});