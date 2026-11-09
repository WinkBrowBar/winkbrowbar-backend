// Zenoti + Shopify API clients for the inventory sync (throttled, with retry).
// Uses ZENOTI_API_KEY / ZENOTI_API_BASE (already in this backend's .env) and these NEW env vars:
//   SHOPIFY_INVENTORY_CLIENT_ID, SHOPIFY_INVENTORY_CLIENT_SECRET   (the "Inventory Sync" Dev Dashboard app)
//   INVENTORY_SHOPIFY_STORE_DOMAIN   (optional, defaults to SHOPIFY_STORE_DOMAIN, e.g. winkbrow-bar.myshopify.com)
//   INVENTORY_SHOPIFY_API_VERSION    (optional, default 2024-10)
// Self-contained: nothing here touches the attribution code or database.
const axios = require('axios');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Zenoti
// Zenoti allows 60 calls/min per account and the rest of this backend shares that budget,
// so these calls stay well under it (1 call / 1.5s).
const ZENOTI_MIN_GAP_MS = 1500;
let zenotiLast = 0;

async function zenotiGet(path, params, retries = 3) {
  if (!process.env.ZENOTI_API_KEY) throw new Error('ZENOTI_API_KEY missing');
  for (let attempt = 0; ; attempt++) {
    const wait = zenotiLast + ZENOTI_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    zenotiLast = Date.now();
    try {
      const { data } = await axios.get(`${process.env.ZENOTI_API_BASE || 'https://api.zenoti.com'}${path}`, {
        params, timeout: 30000, headers: { Authorization: `apikey ${process.env.ZENOTI_API_KEY}` },
      });
      return data;
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 429 && attempt < retries) { await sleep(2000 * 2 ** attempt); continue; }
      throw err;
    }
  }
}

// Retail stock for one center: [{ code, name, quantity }]. product_type=1 is Retail; category is
// checked again because Zenoti also returns fee/migration placeholder rows.
async function zenotiRetailStock(centerId) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const data = await zenotiGet('/v1/inventory/stock', { center_id: centerId, inventory_date: today, product_type: 1 });
  return (data.list || [])
    .filter((p) => String(p.category || '').trim().toLowerCase() === 'retail')
    .map((p) => ({ code: String(p.product_code), name: p.product_name, quantity: Number(p.total_quantity) }));
}

// ---------------------------------------------------------------- Shopify
const SHOPIFY_MIN_GAP_MS = 600; // REST bucket refills 2 calls/sec
let shopifyLast = 0;
let tokenCache = null;

function shopifyShop() {
  const d = process.env.INVENTORY_SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
  if (!d) throw new Error('INVENTORY_SHOPIFY_STORE_DOMAIN (or SHOPIFY_STORE_DOMAIN) missing');
  return d.replace(/\.myshopify\.com$/, '');
}

async function shopifyToken() {
  if (tokenCache && tokenCache.expires > Date.now() + 60000) return tokenCache.token;
  const { SHOPIFY_INVENTORY_CLIENT_ID: id, SHOPIFY_INVENTORY_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error('SHOPIFY_INVENTORY_CLIENT_ID / SHOPIFY_INVENTORY_CLIENT_SECRET missing');
  const { data } = await axios.post(
    `https://${shopifyShop()}.myshopify.com/admin/oauth/access_token`,
    new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  tokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in || 86000) * 1000 };
  return tokenCache.token;
}

async function shopifyRequest(method, path, { params, body } = {}, retries = 4) {
  const version = process.env.INVENTORY_SHOPIFY_API_VERSION || '2024-10';
  for (let attempt = 0; ; attempt++) {
    const wait = shopifyLast + SHOPIFY_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    shopifyLast = Date.now();
    try {
      return await axios.request({
        method, params, data: body, timeout: 30000,
        url: path.startsWith('http') ? path : `https://${shopifyShop()}.myshopify.com/admin/api/${version}${path}`,
        headers: { 'X-Shopify-Access-Token': await shopifyToken(), 'Content-Type': 'application/json' },
      });
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 429 && attempt < retries) { await sleep((Number(err.response.headers['retry-after']) || 2) * 1000); continue; }
      throw err;
    }
  }
}

// All products with their variants (follows Link-header pagination).
async function shopifyAllVariants() {
  const out = [];
  let next = { path: '/products.json', params: { limit: 250, fields: 'id,title,status,variants' } };
  while (next) {
    const res = await shopifyRequest('get', next.path, { params: next.params });
    for (const p of res.data.products) {
      for (const v of p.variants) {
        out.push({ product: p.title, status: p.status, variant: v.title, sku: (v.sku || '').trim(), variant_id: v.id, inventory_item_id: v.inventory_item_id, inventory_management: v.inventory_management });
      }
    }
    const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.link || '');
    next = m ? { path: m[1], params: undefined } : null;
  }
  return out;
}

// Current `available` at one location: Map(inventory_item_id -> available)
async function shopifyLevels(locationId, itemIds) {
  const map = new Map();
  for (let i = 0; i < itemIds.length; i += 50) {
    const res = await shopifyRequest('get', '/inventory_levels.json', {
      params: { inventory_item_ids: itemIds.slice(i, i + 50).join(','), location_ids: locationId, limit: 250 },
    });
    res.data.inventory_levels.forEach((l) => map.set(l.inventory_item_id, l.available));
  }
  return map;
}

async function shopifySetLevel(locationId, inventoryItemId, available) {
  const res = await shopifyRequest('post', '/inventory_levels/set.json', {
    body: { location_id: locationId, inventory_item_id: inventoryItemId, available },
  });
  return res.data.inventory_level;
}

// Stock a location at Shopify before setting it (creates the level at 0).
async function shopifyConnect(locationId, inventoryItemId) {
  const res = await shopifyRequest('post', '/inventory_levels/connect.json', {
    body: { location_id: locationId, inventory_item_id: inventoryItemId, relocate_if_necessary: false },
  });
  return res.data.inventory_level;
}

// Variant ids (numbers) that are component-based bundles (Shopify Bundles app). Shopify derives
// their stock from the components, so the sync must not set it.
async function shopifyBundleVariantIds() {
  const ids = new Set();
  let after = null;
  do {
    const q = `{ products(first: 25${after ? `, after: "${after}"` : ''}) { pageInfo { hasNextPage endCursor }
      edges { node { variants(first: 50) { edges { node { legacyResourceId requiresComponents } } } } } } }`;
    const res = await shopifyRequest('post', '/graphql.json', { body: { query: q } });
    if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
    const conn = res.data.data.products;
    conn.edges.forEach(({ node }) => node.variants.edges.forEach(({ node: v }) => { if (v.requiresComponents) ids.add(Number(v.legacyResourceId)); }));
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

// ---------------------------------------------------------------- name matching
// Name tokens: lowercase, & and + -> "and", grey->gray, DB/DG/LB expanded, filler words dropped,
// order ignored. Used only to SUGGEST links - you confirm them on the Inventory page.
const ABBR = { db: 'dark brown', dg: 'dark gray', lb: 'light brown' };
function tokens(s) {
  return String(s || '').toLowerCase().replace(/[®™]/g, '').replace(/[&+]/g, ' and ').replace(/grey/g, 'gray')
    .split(/[^a-z0-9]+/).filter(Boolean)
    .flatMap((t) => (ABBR[t] ? ABBR[t].split(' ') : [t]))
    .filter((t) => !['and', 'with', 'default', 'title'].includes(t))
    .sort().join(' ');
}

module.exports = { zenotiRetailStock, shopifyAllVariants, shopifyLevels, shopifySetLevel, shopifyConnect, shopifyBundleVariantIds, tokens };