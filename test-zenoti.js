// test-zenoti.js
//
// Standalone, read-only. Confirms what Zenoti's API actually returns for:
//   1. The list of centers on this account (so we know real center_ids/codes)
//   2. A center's product list (to confirm `code` == the ProductCode from
//      your Shopify CSV export, e.g. "24", "40", ...)
//   3. The stock-quantity endpoint for one center (store_quantity /
//      floor_quantity / total_quantity per product)
//
// This is NOT wired into winkbrowbar-backend - it's a separate script so
// nothing in the existing backend is touched. Run it from wherever you have
// the real ZENOTI_API_KEY available (e.g. copy this folder onto the server,
// or paste the key into a local .env here).
//
// Usage:
//   npm install
//   cp .env.example .env   # then fill in ZENOTI_API_KEY
//   npm run test:zenoti
//
// Optional: node test-zenoti.js --center=<center_id>   to skip center
// selection and go straight to one center's products + stock.

require('dotenv').config();
const axios = require('axios');

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;

function headers() {
  return { Authorization: `apikey ${ZENOTI_API_KEY}` };
}

function argValue(name) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : null;
}

async function listCenters() {
  const { data } = await axios.get(`${ZENOTI_API_BASE}/v1/centers`, { headers: headers() });
  return data.centers || data || [];
}

async function listCenterProducts(centerId, { page = 1, size = 10 } = {}) {
  const { data } = await axios.get(`${ZENOTI_API_BASE}/v1/centers/${centerId}/products`, {
    headers: headers(),
    params: { page, size },
  });
  return data;
}

async function getStock(centerId, inventoryDate) {
  const { data } = await axios.get(`${ZENOTI_API_BASE}/v1/inventory/stock`, {
    headers: headers(),
    params: { center_id: centerId, inventory_date: inventoryDate, product_type: 3 },
  });
  return data;
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

async function run() {
  if (!ZENOTI_API_KEY) {
    console.error('Missing ZENOTI_API_KEY - fill in .env (see .env.example)');
    process.exit(1);
  }

  console.log('=== 1. Centers on this Zenoti account ===');
  const centers = await listCenters();
  console.log(`Found ${centers.length} center(s):\n`);
  centers.forEach((c) => {
    console.log(`- id=${c.id}  code=${c.code}  name=${c.name}`);
  });

  const forcedCenterId = argValue('center');
  const targetCenter = forcedCenterId
    ? centers.find((c) => c.id === forcedCenterId) || { id: forcedCenterId }
    : centers.find((c) => /wink/i.test(c.name || '')) || centers[0];

  if (!targetCenter) {
    console.log('\nNo center available to test products/stock against. Pass --center=<id> explicitly.');
    return;
  }

  console.log(`\n=== 2. Products for center "${targetCenter.name || targetCenter.id}" (first page) ===`);
  const productsResp = await listCenterProducts(targetCenter.id, { page: 1, size: 10 });
  const products = productsResp.products || productsResp || [];
  console.log(`Got ${Array.isArray(products) ? products.length : '?'} product row(s) on page 1. Raw sample:\n`);
  console.log(JSON.stringify(Array.isArray(products) ? products.slice(0, 3) : productsResp, null, 2));

  console.log(`\n=== 3. Stock for center "${targetCenter.name || targetCenter.id}" on ${todayYmd()} ===`);
  try {
    const stock = await getStock(targetCenter.id, todayYmd());
    console.log(JSON.stringify(stock, null, 2).slice(0, 4000));
  } catch (err) {
    console.error('Stock call failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  }

  console.log('\nDone. Copy this full output back so we can confirm the real field names/shape.');
}

run().catch((err) => {
  console.error('Failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});