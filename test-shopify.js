// test-shopify.js
//
// Standalone, read-only. Confirms what Shopify's Admin API actually returns
// for this store:
//   1. Locations (so we know which location_id to write inventory to)
//   2. A few products + their variants (to confirm each variant's SKU -
//      we need these to match Zenoti's ProductCode, e.g. "24", "40", ...)
//   3. Inventory levels for one variant's inventory_item_id (to see the
//      current `available` quantity shape per location)
//
// NOT wired into winkbrowbar-backend - separate script, nothing existing is
// touched.
//
// Usage:
//   npm install
//   cp .env.example .env   # then fill in SHOPIFY_STORE_DOMAIN + SHOPIFY_ACCESS_TOKEN
//   npm run test:shopify

require('dotenv').config();
const axios = require('axios');

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
// Either a static token (legacy custom app) ...
let ACCESS_TOKEN = process.env.SHOPIFY_INVENTORY_TOKEN || '';
// ... or Dev Dashboard app credentials (token is fetched via client credentials grant, ~24h life)
const CLIENT_ID = process.env.SHOPIFY_INVENTORY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_INVENTORY_CLIENT_SECRET;

async function fetchClientCredentialsToken() {
  const shop = STORE_DOMAIN.replace(/\.myshopify\.com$/, '');
  const { data } = await axios.post(
    `https://${shop}.myshopify.com/admin/oauth/access_token`,
    new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  console.log(`Got token via client credentials. Granted scopes: ${data.scope}\n`);
  return data.access_token;
}

function client() {
  return axios.create({
    baseURL: `https://${STORE_DOMAIN}/admin/api/${API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
  });
}

async function run() {
  if (!STORE_DOMAIN || (!ACCESS_TOKEN && !(CLIENT_ID && CLIENT_SECRET))) {
    console.error('Missing SHOPIFY_STORE_DOMAIN and either SHOPIFY_INVENTORY_TOKEN or SHOPIFY_INVENTORY_CLIENT_ID + SHOPIFY_INVENTORY_CLIENT_SECRET - fill in .env');
    process.exit(1);
  }
  if (!ACCESS_TOKEN) ACCESS_TOKEN = await fetchClientCredentialsToken();
  const http = client();

  console.log('=== 1. Locations on this Shopify store ===');
  const { data: locData } = await http.get('/locations.json');
  const locations = locData.locations || [];
  console.log(`Found ${locations.length} location(s):\n`);
  locations.forEach((l) => console.log(`- id=${l.id}  name=${l.name}  active=${l.active}`));

  console.log('\n=== 2. First 5 products + variants (checking SKU field) ===');
  const { data: prodData } = await http.get('/products.json', { params: { limit: 5 } });
  const products = prodData.products || [];
  products.forEach((p) => {
    console.log(`\nProduct: "${p.title}" (id=${p.id})`);
    (p.variants || []).forEach((v) => {
      console.log(`  variant_id=${v.id}  sku="${v.sku}"  inventory_item_id=${v.inventory_item_id}  inventory_quantity=${v.inventory_quantity}`);
    });
  });

  const firstVariant = products[0] && products[0].variants && products[0].variants[0];
  if (firstVariant && firstVariant.inventory_item_id) {
    console.log(`\n=== 3. Inventory levels for inventory_item_id=${firstVariant.inventory_item_id} (across all locations) ===`);
    const { data: levelData } = await http.get('/inventory_levels.json', {
      params: {
        inventory_item_ids: firstVariant.inventory_item_id,
        location_ids: locations.map((l) => l.id).join(','),
      },
    });
    console.log(JSON.stringify(levelData, null, 2));
  } else {
    console.log('\nNo variant with inventory_item_id found on first product - skipping inventory-levels check.');
  }

  console.log('\nDone. Copy this full output back so we can confirm the real field names/shape.');
}

run().catch((err) => {
  console.error('Failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});