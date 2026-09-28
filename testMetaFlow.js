/**
 * Standalone Meta connector test.
 *
 * Reads credentials from MongoDB (same MarketingPlatform record
 * setMetaCredentials.js writes) and calls the real metaConnector.js code
 * directly. Two checks, in order of safety:
 *
 *   1. fetchSpend() - fully read-only Ads Insights call. Confirms the
 *      accessToken + adAccountId are valid and the token has the
 *      `ads_read` permission. Zero risk of sending anything.
 *   2. send() with a testEventCode - Meta's own dry-run mode. The event
 *      shows up live in Events Manager -> your pixel -> Test Events tab
 *      instead of being recorded as a real conversion. Confirms pixelId +
 *      accessToken + payload shape are all accepted.
 *
 * Usage:
 *   node testMetaFlow.js <BRAND_ID> <TEST_EVENT_CODE>
 *
 * TEST_EVENT_CODE comes from Events Manager -> your pixel -> Test Events
 * tab (top right, looks like "TEST12345"). Required - without it this
 * script refuses to send, since a send with no test code is a REAL
 * conversion on the pixel.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const MarketingPlatform = require('./src/db/models/MarketingPlatform');
const metaConnector = require('./src/connectors/metaConnector');

async function run() {
  const brandId = process.argv[2];
  const testEventCode = process.argv[3];

  if (!brandId || !testEventCode) {
    console.error('Usage: node testMetaFlow.js <BRAND_ID> <TEST_EVENT_CODE>');
    console.error('TEST_EVENT_CODE: Events Manager -> your pixel -> Test Events tab');
    process.exit(1);
  }
  if (!mongoose.Types.ObjectId.isValid(brandId)) {
    console.error('That does not look like a valid Mongo ObjectId:', brandId);
    process.exit(1);
  }

  await connectDB();

  const record = await MarketingPlatform.findOne({ brandId, platform: 'meta', isActive: true }).lean();
  if (!record) {
    console.error('No active "meta" MarketingPlatform record for this brand - run setMetaCredentials.js first.');
    process.exit(1);
  }
  const credentials = record.credentials || {};
  if (!credentials.pixelId || !credentials.accessToken) {
    console.error('pixelId or accessToken missing/blank on the stored record - run setMetaCredentials.js first.');
    process.exit(1);
  }

  console.log('=== Step 1: fetchSpend() - read-only Ads Insights check ===\n');

  const until = new Date();
  const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000); // last 7 days

  const spendResult = await metaConnector.fetchSpend(credentials, { since, until });

  if (spendResult.success) {
    console.log('accessToken + adAccountId valid, ads_read permission confirmed.');
    console.log(`Campaign rows returned: ${spendResult.spend.length}`);
    if (spendResult.spend.length > 0) {
      console.log('Sample row:', spendResult.spend[0]);
    } else {
      console.log('(No spend in the last 7 days - that\'s fine, doesn\'t mean it failed.)');
    }
  } else {
    console.error('fetchSpend FAILED:', spendResult.error);
    console.log('\nIf this 403s specifically, the access token may be missing the');
    console.log('`ads_read` permission (different scope from the Conversions API');
    console.log('send below) - regenerate it with that permission included.');
    console.log('Continuing to Step 2 anyway, since send() uses a different scope.\n');
  }

  console.log('\n=== Step 2: send() with testEventCode - Meta dry-run ===\n');
  console.log('(Shows up in Events Manager -> Test Events, NOT recorded as a real conversion.)\n');

  const testConversion = {
    email: 'test@example.com',
    phone: null,
    amount: 1.00,
    currency: 'USD',
    orderId: 'test_order_' + Date.now(),
    eventTime: new Date(),
    testEventCode,
  };

  const sendResult = await metaConnector.send(testConversion, credentials);

  console.log('Success:', sendResult.success);
  console.log('Full response:', JSON.stringify(sendResult.response, null, 2));
  if (!sendResult.success) {
    console.log('Error:', sendResult.error);
  }

  console.log('\n=== What to look for ===');
  console.log('- If success is true, go check Events Manager -> your pixel ->');
  console.log('  Test Events tab - the event should appear there within a few');
  console.log('  seconds, with a green "Purchase" row and no field warnings.');
  console.log('- If it does NOT show up there even though success was true,');
  console.log('  something is off with pixelId (wrong pixel) even though the');
  console.log('  API accepted the request.');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Unexpected failure:', err.message);
  process.exit(1);
});