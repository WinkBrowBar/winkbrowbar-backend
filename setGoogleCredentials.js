// setGoogleCredentials.js
//
// Creates (or updates) the MarketingPlatform record Google conversions
// actually get sent from. This is the piece that's missing right now -
// checkGoogleCredentials.js confirmed zero "google" records exist.
//
// Two fields below are still blank / unconfirmed - fill them in before
// running:
//   - developerToken: from Google Ads UI -> Tools & Settings -> API Center
//     (this is separate from the OAuth client id/secret above it)
//   - conversionActionId: must be the NUMERIC Google Ads conversion action
//     ID (Goals -> Conversions -> click the action -> ID is numeric, e.g.
//     876543210), NOT a gtag conversion label like "AW-xxx/nRNYCPvhl0..."
//
// Usage:
//   node setGoogleCredentials.js <BRAND_ID>
//
// BRAND_ID is the same brandId every other script here already takes.

require('dotenv').config();
const { connectDB, mongoose } = require('./src/db/connection');
const MarketingPlatform = require('./src/db/models/MarketingPlatform');

// ---- fill in the two blank values below before running ----
const CREDENTIALS = {
  clientId: '992081553561-0iete7cm6h810j96i41faaqnkf0u63pj.apps.googleusercontent.com',
  clientSecret: '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',
  refreshToken: '1//0g84CsWYJH15hCgYIARAAGBASNwF-L9Ir7RX-JHjBzHN_K20MKhCIuPpnvkBcaA01i-NYRos3FDQhAfIJVuC3NSW8bzpjuwSoZi0',
  developerToken: 'td2JgeoJA-G3aLkxiRPlVQ',           // <-- fill in from API Center
  customerId: '1410219362',
  conversionActionId: '',       // <-- fill in with the NUMERIC action id, not the gtag label
};
// --------------------------------------------------------------

(async () => {
  const brandId = process.argv[2];
  if (!brandId) {
    console.error('Usage: node setGoogleCredentials.js <BRAND_ID>');
    process.exit(1);
  }
  if (!mongoose.Types.ObjectId.isValid(brandId)) {
    console.error('That does not look like a valid Mongo ObjectId:', brandId);
    process.exit(1);
  }

  const missing = Object.entries(CREDENTIALS).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('Missing values for:', missing.join(', '));
    console.error('Edit the CREDENTIALS object at the top of this file, then re-run.');
    process.exit(1);
  }

  if (!/^\d+$/.test(CREDENTIALS.conversionActionId)) {
    console.error(
      `conversionActionId ("${CREDENTIALS.conversionActionId}") isn't purely numeric - ` +
      'that usually means a gtag conversion label got used instead of the real Ads API conversion action ID. ' +
      'Double check Goals -> Conversions -> the action -> ID in Google Ads before proceeding.'
    );
    process.exit(1);
  }

  await connectDB();

  const result = await MarketingPlatform.findOneAndUpdate(
    { brandId, platform: 'google' },
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
  console.log('\nNext: re-run  node reconcileMisattributedConversions.js 60 --send');

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});