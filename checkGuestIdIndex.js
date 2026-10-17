// checkGuestIdIndex.js
//
// Checks whether the unique partial index on Customer{brandId, zenotiGuestId}
// (declared in src/db/models/Customer.js) actually exists on the LIVE
// MongoDB collection - Mongoose's autoIndex build fails silently (no
// listener on the 'index' event in src/db/connection.js) if duplicate
// zenotiGuestId docs already existed when the index was added. If it's
// missing, the E11000-catch race protection in identityResolution.js is a
// no-op and duplicate Customer docs for the same guest can keep forming.
//
// Also reports how many zenotiGuestId values currently have >1 Customer
// doc across ALL brands, as a cross-check.
//
// Usage: node checkGuestIdIndex.js

require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Customer = require('./src/db/models/Customer');

(async () => {
  await connectDB();

  const indexes = await Customer.collection.indexes();
  console.log('Indexes currently on the customers collection:\n');
  for (const idx of indexes) {
    console.log(`  ${idx.name}  key=${JSON.stringify(idx.key)}  unique=${!!idx.unique}  partialFilterExpression=${JSON.stringify(idx.partialFilterExpression || null)}`);
  }

  const target = indexes.find((idx) => idx.key && idx.key.brandId === 1 && idx.key.zenotiGuestId === 1);
  console.log('\n' + (target
    ? (target.unique
      ? '✅ Unique index on (brandId, zenotiGuestId) IS live. The E11000 race-protection is actually active.'
      : '⚠️  An index on (brandId, zenotiGuestId) exists but it is NOT unique - the schema wants unique, so the build was likely downgraded/failed. Race protection is NOT active.')
    : '❌ No index on (brandId, zenotiGuestId) found at all. The build silently failed. Race protection is NOT active - duplicates WILL keep happening.'));

  const dupes = await Customer.aggregate([
    { $match: { zenotiGuestId: { $exists: true, $ne: null } } },
    { $group: { _id: { brandId: '$brandId', zenotiGuestId: '$zenotiGuestId' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  console.log(`\n${dupes.length} zenotiGuestId(s) currently split across multiple Customer docs (across all brands).`);
  if (dupes.length) {
    console.log('(If the index above is missing/non-unique, this number can only grow over time until it\'s rebuilt.)');
  }

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});