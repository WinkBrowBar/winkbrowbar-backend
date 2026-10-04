/**
 * Read-only: shows the last N conversions for a brand, including their
 * status (sent/failed/skipped) and any error/response detail stored - the
 * dashboard only shows "sent" conversions, so this is how we actually see
 * what happened with test sends to Meta/AWIN/Klaviyo, including failures.
 *
 * Usage:
 *   node inspectConversions.js                  -> last 10, any platform
 *   node inspectConversions.js meta 5            -> last 5 meta conversions
 *   node inspectConversions.js klaviyo 5
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');

const platform = process.argv[2];
const limit = Number(process.argv[3]) || 10;

async function run() {
  await connectDB();

  const filter = {};
  if (platform) filter.platform = platform;

  const conversions = await Conversion.find(filter).sort({ createdAt: -1 }).limit(limit);

  if (conversions.length === 0) {
    console.log('No matching conversions found.');
  }

  for (const c of conversions) {
    console.log('\n========================================');
    console.log(`platform: ${c.platform}  |  status: ${c.status}  |  amount: ${c.amount}`);
    console.log(`createdAt: ${c.createdAt}  |  attributionVisitId: ${c.attributionVisitId || 'none'}`);
    if (c.platformResponse) console.log(`platformResponse: ${JSON.stringify(c.platformResponse, null, 2)}`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Inspection failed:', err);
  process.exit(1);
});