/**
 * Calls the Zenoti API directly to list ALL centers on the account,
 * including ones with zero invoices/bookings so far (e.g. a brand new
 * location like Upper East Side that hasn't taken a booking yet).
 *
 * Uses the same ZENOTI_API_KEY / ZENOTI_API_BASE env vars already used by
 * backfillMissedZenotiInvoices.js - no new credentials needed.
 *
 * Usage:
 *   node listZenotiCentersFromApi.js
 */
require('dotenv').config();
const axios = require('axios');

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;

async function run() {
  if (!ZENOTI_API_KEY) {
    throw new Error('ZENOTI_API_KEY is not set in .env');
  }

  const response = await axios.get(`${ZENOTI_API_BASE}/v1/centers`, {
    headers: { Authorization: `apikey ${ZENOTI_API_KEY}` },
  });

  const centers = response.data.centers || response.data || [];

  console.log(`Found ${centers.length} center(s) on this Zenoti account:\n`);
  centers.forEach((c) => {
    console.log('---');
    console.log(`id:      ${c.id}`);
    console.log(`code:    ${c.code}`);
    console.log(`name:    ${c.name}`);
    console.log(`address: ${c.address || '(n/a)'}`);
  });
}

run().catch((err) => {
  console.error('Failed to list centers from Zenoti API:', err.response ? err.response.data : err.message);
  process.exit(1);
});