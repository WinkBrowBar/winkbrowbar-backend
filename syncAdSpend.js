/**
 * Pulls campaign spend from Meta and Google's reporting APIs and stores it
 * in the AdSpend collection, for every brand with active credentials for
 * those platforms. AWIN and Klaviyo are skipped - AWIN is commission-based
 * (already captured via Conversion.platformResponse when a sale is
 * reported), and Klaviyo has no ad-spend concept.
 *
 * Run manually, or schedule (e.g. Railway cron, or a simple daily
 * `node syncAdSpend.js` via any scheduler) - safe to re-run, upserts by
 * brand+platform+campaign+day so re-running just refreshes the numbers.
 *
 * Usage:
 *   node syncAdSpend.js                  -> last 30 days, all brands
 *   node syncAdSpend.js 7                -> last 7 days, all brands
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const MarketingPlatform = require('./src/db/models/MarketingPlatform');
const AdSpend = require('./src/db/models/AdSpend');
const metaConnector = require('./src/connectors/metaConnector');
const googleConnector = require('./src/connectors/googleConnector');

const days = Number(process.argv[2]) || 30;
const until = new Date();
const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

const connectors = { meta: metaConnector, google: googleConnector };

async function syncOne(brand, platformDoc) {
  const connector = connectors[platformDoc.platform];
  const result = await connector.fetchSpend(platformDoc.credentials, { since, until });

  if (!result.success) {
    console.log(`  [${platformDoc.platform}] FAILED: ${result.error}`);
    return { synced: 0, failed: 1 };
  }

  let synced = 0;
  for (const row of result.spend) {
    await AdSpend.findOneAndUpdate(
      { brandId: brand._id, platform: platformDoc.platform, campaignId: row.campaignId, date: new Date(row.date) },
      { ...row, brandId: brand._id, platform: platformDoc.platform, date: new Date(row.date) },
      { upsert: true }
    );
    synced++;
  }
  console.log(`  [${platformDoc.platform}] synced ${synced} row(s)`);
  return { synced, failed: 0 };
}

async function run() {
  await connectDB();
  console.log(`Syncing ad spend for the last ${days} days (${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)})\n`);

  const brands = await Brand.find({ isActive: true });
  let totalSynced = 0;
  let totalFailed = 0;

  for (const brand of brands) {
    const platforms = await MarketingPlatform.find({
      brandId: brand._id,
      isActive: true,
      platform: { $in: ['meta', 'google'] },
    });

    if (platforms.length === 0) continue;

    console.log(`Brand: ${brand.name}`);
    for (const p of platforms) {
      const { synced, failed } = await syncOne(brand, p);
      totalSynced += synced;
      totalFailed += failed;
    }
  }

  console.log(`\nDone. ${totalSynced} row(s) synced, ${totalFailed} platform(s) failed.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});