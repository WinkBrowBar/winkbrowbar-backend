// setMetaCredentials.js
//
// Creates (or updates) the MarketingPlatform record Meta conversions get
// sent from. checkPlatformCredentials.js showed the current "meta" record
// has placeholder values (pixelId/accessToken = "<ful...rds>", adAccountId
// = "act_...XXXX") - never actually filled in with real credentials.
//
// Reads pixelId/accessToken straight from .env (META_PIXEL_ID,
// META_CONVERSIONS_API_TOKEN) - same as every other connector's static
// credentials already work. adAccountId is NOT in .env and is optional:
// it's only used by fetchSpend() (ad-spend reporting), not by send()
// (actually sending conversions), so this can run without it. Add it
// later - Ads Manager, top-left account dropdown - and re-run this script
// to fill it in.
//
// Usage:
//   node setMetaCredentials.js <BRAND_ID>

require('dotenv').config();
const { connectDB, mongoose } = require('./src/db/connection');
const MarketingPlatform = require('./src/db/models/MarketingPlatform');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return value;
}

const CREDENTIALS = {
  pixelId: requireEnv('META_PIXEL_ID'),
  accessToken: requireEnv('META_CONVERSIONS_API_TOKEN'),
  adAccountId: process.env.META_AD_ACCOUNT_ID || '', // optional - only needed for spend-fetching, not for sending conversions
};

(async () => {
  const brandId = process.argv[2];
  if (!brandId) {
    console.error('Usage: node setMetaCredentials.js <BRAND_ID>');
    process.exit(1);
  }
  if (!mongoose.Types.ObjectId.isValid(brandId)) {
    console.error('That does not look like a valid Mongo ObjectId:', brandId);
    process.exit(1);
  }

  if (!/^\d+$/.test(CREDENTIALS.pixelId)) {
    console.error(
      `META_PIXEL_ID ("${CREDENTIALS.pixelId}") isn't purely numeric - double check Events Manager -> ` +
      'your pixel -> Settings for the real numeric pixel ID.'
    );
    process.exit(1);
  }
  if (!CREDENTIALS.adAccountId) {
    console.warn('META_AD_ACCOUNT_ID not set in .env - saving without it. Ad-spend fetching will not work until it is added; conversion sending is unaffected.');
  }

  await connectDB();

  const result = await MarketingPlatform.findOneAndUpdate(
    { brandId, platform: 'meta' },
    { $set: { credentials: CREDENTIALS, isActive: true } },
    { upsert: true, new: true }
  );

  console.log('Saved MarketingPlatform record:');
  console.log({
    _id: result._id.toString(),
    brandId: result.brandId.toString(),
    platform: result.platform,
    isActive: result.isActive,
    credentialKeys: Object.keys(result.credentials || {}),
  });
  console.log('\nNext: node testMetaFlow.js <BRAND_ID> <TEST_EVENT_CODE>');

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});