// checkZenotiGuestLookup.js
//
// Tests whether this Zenoti account's API key can do a live guest-by-email
// lookup (Zenoti's Guest Search endpoint) - the thing that would let us
// check new-vs-returning by hitting Zenoti directly with just an email,
// instead of relying on our own db + the nightly reconcile script.
//
// We don't yet know if this account's key is authorized for this endpoint
// - only the Sales Accrual Report has been confirmed working so far
// (reconcileZenotiInvoices.js). This prints the RAW response either way so
// we can see exactly what's available (or exactly how it's denied) instead
// of guessing.
//
// Usage:
//   node checkZenotiGuestLookup.js someone@example.com

require('dotenv').config();
const axios = require('axios');

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;

async function getCenters() {
  const { data } = await axios.get(`${ZENOTI_API_BASE}/v1/centers`, {
    headers: { Authorization: `apikey ${ZENOTI_API_KEY}` },
  });
  return data.centers || data || [];
}

async function tryGuestSearch({ email, centerId }) {
  const params = { email };
  if (centerId) params.center_id = centerId;
  console.log(`\n--- GET /v1/guests/search?${new URLSearchParams(params)} ---`);
  try {
    const { data } = await axios.get(`${ZENOTI_API_BASE}/v1/guests/search`, {
      params,
      headers: { Authorization: `apikey ${ZENOTI_API_KEY}` },
    });
    console.log('SUCCESS. Raw response:');
    console.log(JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.log('FAILED:', err.response ? JSON.stringify(err.response.data) : err.message);
    return false;
  }
}

(async () => {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node checkZenotiGuestLookup.js someone@example.com');
    process.exit(1);
  }
  if (!ZENOTI_API_KEY) {
    console.error('ZENOTI_API_KEY is not set in .env');
    process.exit(1);
  }

  // Try without a center_id first - some Zenoti accounts require it, some
  // don't, depending on API version/plan.
  const okWithoutCenter = await tryGuestSearch({ email });
  if (okWithoutCenter) {
    console.log('\nWorked without a center_id.');
    process.exit(0);
  }

  console.log('\nRetrying with a center_id, in case this endpoint requires one...');
  let centers = [];
  try {
    centers = await getCenters();
  } catch (err) {
    console.log('Could not fetch centers to retry with:', err.response ? JSON.stringify(err.response.data) : err.message);
    process.exit(1);
  }

  if (!centers.length) {
    console.log('No centers returned - cannot retry with a center_id.');
    process.exit(1);
  }

  console.log(`Got ${centers.length} center(s), trying the first one: ${centers[0].name} (${centers[0].id})`);
  await tryGuestSearch({ email, centerId: centers[0].id });

  process.exit(0);
})();