/**
 * Standalone Google Ads connector test.
 *
 * Reads credentials straight from process.env (GOOGLE_ADS_*) and calls the
 * real googleConnector.js code directly - does NOT touch MongoDB, does NOT
 * go through the webhook/attribution pipeline, does NOT create any
 * Conversion record. Safe to run repeatedly.
 *
 * Two checks, in order of safety:
 *   1. fetchSpend() - fully read-only. Confirms OAuth (clientId/secret/
 *      refreshToken) and developerToken/customerId are all valid, with zero
 *      risk of sending anything to Google.
 *   2. send() with validateOnly: true - Google's own dry-run mode. Confirms
 *      the event payload shape is accepted, without actually recording a
 *      real conversion on the ad account.
 *
 * Usage:
 *   node testGoogleAdsFlow.js
 *
 * Requires in .env:
 *   GOOGLE_ADS_DEVELOPER_TOKEN=
 *   GOOGLE_ADS_CLIENT_ID=
 *   GOOGLE_ADS_CLIENT_SECRET=
 *   GOOGLE_ADS_REFRESH_TOKEN=
 *   GOOGLE_ADS_CUSTOMER_ID=
 */
require('dotenv').config();
const googleConnector = require('./src/connectors/googleConnector');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} in .env - cannot proceed.`);
    process.exit(1);
  }
  return value;
}

const credentials = {
  developerToken: requireEnv('GOOGLE_ADS_DEVELOPER_TOKEN'),
  clientId: requireEnv('GOOGLE_ADS_CLIENT_ID'),
  clientSecret: requireEnv('GOOGLE_ADS_CLIENT_SECRET'),
  refreshToken: requireEnv('GOOGLE_ADS_REFRESH_TOKEN'),
  customerId: requireEnv('GOOGLE_ADS_CUSTOMER_ID'),
  conversionActionId: requireEnv('GOOGLE_ADS_CONVERSION_ACTION_ID'),
};

async function run() {
  console.log('=== Step 1: fetchSpend() - read-only OAuth + credentials check ===\n');

  const until = new Date();
  const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000); // last 7 days

  const spendResult = await googleConnector.fetchSpend(credentials, { since, until });

  if (spendResult.success) {
    console.log(`OAuth + developer token + customer ID all valid.`);
    console.log(`Campaign rows returned: ${spendResult.spend.length}`);
    if (spendResult.spend.length > 0) {
      console.log('Sample row:', spendResult.spend[0]);
    } else {
      console.log('(No spend in the last 7 days - that\'s fine, doesn\'t mean it failed.)');
    }
  } else {
    console.error('fetchSpend FAILED:', spendResult.error);
    console.log('\nThis means the credentials themselves are the problem (wrong');
    console.log('token, wrong customer ID, developer token not approved, etc.) -');
    console.log('fix this before testing send() below.\n');
    process.exit(1);
  }

  console.log('\n=== Step 2: send() with validateOnly: true - Google dry-run ===\n');
  console.log('(This does NOT create a real conversion - it only checks the payload shape.)\n');

  const testConversion = {
    clickId: 'test_gclid_' + Date.now(), // fake gclid - fine for validateOnly
    email: 'test@example.com',
    phone: null,
    amount: 1.00,
    currency: 'USD',
    orderId: 'test_order_' + Date.now(),
    eventTime: new Date(),
    validateOnly: true,
  };

  const sendResult = await googleConnector.send(testConversion, credentials);

  console.log('Success:', sendResult.success);
  console.log('Full response:', JSON.stringify(sendResult.response, null, 2));
  if (!sendResult.success) {
    console.log('Error:', sendResult.error);
  }

  console.log('\n=== What to look for ===');
  console.log('- Check the response above for "field_warnings" or similar -');
  console.log('  these tell you if any field name/shape is wrong, even if');
  console.log('  success is technically true.');
  console.log('- If this looks clean, the connector is ready for a real test');
  console.log('  send (validateOnly: false) - but only do that with a real,');
  console.log('  small, known test purchase, not synthetic data.');
}

run().catch((err) => {
  console.error('Unexpected failure:', err.message);
  process.exit(1);
});