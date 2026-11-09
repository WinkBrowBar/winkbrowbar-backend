// structure-probe.js - standalone, READ-ONLY. Run from any folder that has a .env with:
//   ZENOTI_API_KEY, SHOPIFY_STORE_DOMAIN, SHOPIFY_INVENTORY_CLIENT_ID, SHOPIFY_INVENTORY_CLIENT_SECRET
// and axios + dotenv installed (your winkbrowbar-backend-main folder already has both).
//
// Answers two open questions:
//  1) Zenoti: is total_quantity = store + floor for retail? Any stock on the floor?
//  2) Shopify: which variants are component-based bundles (Shopify Bundles app)?
//     Their stock is derived from components and can't be set directly.
//
// Usage: node structure-probe.js
require('dotenv').config();
const axios = require('axios');

const CENTERS = {
  CH: '23c89dee-8285-4c13-b081-12652173dc17',
  WV: 'fe6b4dd3-1c8c-4f6e-84ac-42e6f81a001a',
  UES: '188b010f-a060-4ba9-a5c0-56ffb4339479',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function zenotiStock(centerId, date) {
  const { data } = await axios.get(`${process.env.ZENOTI_API_BASE || 'https://api.zenoti.com'}/v1/inventory/stock`, {
    params: { center_id: centerId, inventory_date: date, product_type: 1 },
    headers: { Authorization: `apikey ${process.env.ZENOTI_API_KEY}` },
    timeout: 30000,
  });
  return data.list || [];
}

async function shopifyToken(shop) {
  const { data } = await axios.post(
    `https://${shop}.myshopify.com/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_INVENTORY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_INVENTORY_CLIENT_SECRET,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return data.access_token;
}

(async () => {
  for (const k of ['ZENOTI_API_KEY', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_INVENTORY_CLIENT_ID', 'SHOPIFY_INVENTORY_CLIENT_SECRET']) {
    if (!process.env[k]) throw new Error(`${k} is missing in .env`);
  }

  // ---------- 1) Zenoti raw stock rows, every center
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (const [name, id] of Object.entries(CENTERS)) {
    const rows = (await zenotiStock(id, today)).filter((r) => String(r.category || '').trim() === 'Retail');
    const mismatch = rows.filter((r) => Number(r.store_quantity) + Number(r.floor_quantity) !== Number(r.total_quantity));
    const onFloor = rows.filter((r) => Number(r.floor_quantity) !== 0);
    console.log(`Zenoti ${name}: ${rows.length} retail rows | total != store+floor: ${mismatch.length} | rows with floor_quantity != 0: ${onFloor.length}`);
    [...mismatch, ...onFloor].slice(0, 8).forEach((r) => console.log(`   ${r.product_code} ${r.product_name}: store=${r.store_quantity} floor=${r.floor_quantity} total=${r.total_quantity}`));
    await sleep(1500); // stay well under Zenoti's 60 calls/min
  }

  // ---------- 2) Shopify: variants that require components (= Bundles app)
  console.log('\nShopify: checking which variants are component-based bundles...');
  const shop = process.env.SHOPIFY_STORE_DOMAIN.replace(/\.myshopify\.com$/, '');
  const token = await shopifyToken(shop);
  const version = process.env.SHOPIFY_API_VERSION || '2024-10';
  const query = (after) => `{ products(first: 25${after ? `, after: "${after}"` : ''}) {
    pageInfo { hasNextPage endCursor }
    edges { node { title status variants(first: 10) { edges { node { title sku requiresComponents inventoryItem { tracked } } } } } } } }`;

  let after = null; let variantCount = 0;
  const bundles = []; const untracked = [];
  do {
    const res = await axios.post(`https://${shop}.myshopify.com/admin/api/${version}/graphql.json`,
      { query: query(after) }, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 30000 });
    if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
    const conn = res.data.data.products;
    for (const { node: p } of conn.edges) {
      if (!['ACTIVE', 'UNLISTED'].includes(p.status)) continue;
      for (const { node: v } of p.variants.edges) {
        variantCount++;
        if (v.requiresComponents) bundles.push(`${p.title} / ${v.title}`);
        if (!v.inventoryItem.tracked) untracked.push(`${p.title} / ${v.title}`);
      }
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    await sleep(600);
  } while (after);

  console.log(`Checked ${variantCount} active/unlisted variants.`);
  console.log(`Component-based bundle variants (stock derived from components): ${bundles.length}`);
  bundles.forEach((b) => console.log(`   ${b}`));
  console.log(`Variants where Shopify inventory tracking is OFF: ${untracked.length}`);
  untracked.forEach((b) => console.log(`   ${b}`));
  console.log('\nDone. Paste this whole output back.');
})().catch((e) => { console.error('Failed:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });