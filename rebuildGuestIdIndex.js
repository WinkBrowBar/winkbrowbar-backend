// rebuildGuestIdIndex.js
//
// Drops the bad non-unique brandId_1_zenotiGuestId_1 index on customers
// (built that way because duplicates existed when it was first created -
// see checkGuestIdIndex.js) and lets Mongoose recreate it per the schema
// in src/db/models/Customer.js, which declares it unique + partial
// (zenotiGuestId must be a string). Only run this AFTER confirming
// checkGuestIdIndex.js reports 0 duplicate zenotiGuestIds across every
// brand - the unique build will fail again if any duplicate remains.
//
// Usage: node rebuildGuestIdIndex.js

require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Customer = require('./src/db/models/Customer');

(async () => {
  await connectDB();

  const before = await Customer.collection.indexes();
  const existing = before.find((idx) => idx.name === 'brandId_1_zenotiGuestId_1');
  if (existing) {
    console.log('Dropping existing non-unique brandId_1_zenotiGuestId_1 index...');
    await Customer.collection.dropIndex('brandId_1_zenotiGuestId_1');
  } else {
    console.log('No existing brandId_1_zenotiGuestId_1 index found - nothing to drop.');
  }

  console.log('Rebuilding indexes from the schema (Customer.syncIndexes)...');
  const result = await Customer.syncIndexes();
  console.log('syncIndexes result:', result);

  const after = await Customer.collection.indexes();
  console.log('\nIndexes now on the customers collection:\n');
  for (const idx of after) {
    console.log(`  ${idx.name}  key=${JSON.stringify(idx.key)}  unique=${!!idx.unique}  partialFilterExpression=${JSON.stringify(idx.partialFilterExpression || null)}`);
  }

  const target = after.find((idx) => idx.key && idx.key.brandId === 1 && idx.key.zenotiGuestId === 1);
  console.log('\n' + (target && target.unique
    ? '✅ Unique index is now live. Race protection is active.'
    : '❌ Still not unique - check for remaining duplicates with checkGuestIdIndex.js.'));

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});