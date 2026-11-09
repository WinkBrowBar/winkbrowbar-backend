// shopify-catalog.js - READ-ONLY. Dumps every Shopify product/variant, matches each
// to your Zenoti product codes (by SKU first, then by name), shows which
// location(s) hold stock, and writes mapping-draft.json for review.
// Usage: node shopify-catalog.js Products.csv
require('dotenv').config();
const fs = require('fs');
const axios = require('axios');

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const CLIENT_ID = process.env.SHOPIFY_INVENTORY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_INVENTORY_CLIENT_SECRET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map((h) => h.replace(/^﻿/, '').trim());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

// Name tokens: lowercase, & and + -> "and", grey->gray, DB/DG/LB expanded, filler words dropped.
const ABBR = { db: 'dark brown', dg: 'dark gray', lb: 'light brown' };
function tokens(s) {
  return String(s || '').toLowerCase().replace(/[®™]/g, '').replace(/[&+]/g, ' and ').replace(/grey/g, 'gray')
    .split(/[^a-z0-9]+/).filter(Boolean)
    .flatMap((t) => (ABBR[t] ? ABBR[t].split(' ') : [t]))
    .filter((t) => !['and', 'with', 'default', 'title'].includes(t))
    .sort().join(' ');
}

async function getToken() {
  const shop = STORE.replace(/\.myshopify\.com$/, '');
  const { data } = await axios.post(`https://${shop}.myshopify.com/admin/oauth/access_token`,
    new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data.access_token;
}

(async () => {
  if (!STORE || !CLIENT_ID || !CLIENT_SECRET) throw new Error('Need SHOPIFY_STORE_DOMAIN, SHOPIFY_INVENTORY_CLIENT_ID, SHOPIFY_INVENTORY_CLIENT_SECRET');
  const csvPath = process.argv[2] || 'Products.csv';
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found at "${csvPath}" - pass the path: node shopify-catalog.js /path/to/Products.csv`);
  const csv = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const byCode = new Map(csv.map((r) => [r.ProductCode, r]));
  const byTokens = new Map(); csv.forEach((r) => { const k = tokens(r.ProductName); byTokens.set(k, [...(byTokens.get(k) || []), r]); });

  const http = axios.create({ baseURL: `https://${STORE}/admin/api/${API_VERSION}`, headers: { 'X-Shopify-Access-Token': await getToken() } });

  // all products (paginated via Link header)
  const variants = [];
  let url = '/products.json?limit=250&fields=id,title,status,variants';
  while (url) {
    const res = await http.get(url);
    for (const p of res.data.products) for (const v of p.variants) variants.push({ product: p.title, status: p.status, variant: v.title, sku: (v.sku || '').trim(), variant_id: v.id, inventory_item_id: v.inventory_item_id, qty: v.inventory_quantity });
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.link || '');
    url = next ? next[1].replace(`https://${STORE}/admin/api/${API_VERSION}`, '') : null;
    await sleep(550);
  }
  console.log(`Shopify: ${variants.length} variant(s) across ${new Set(variants.map((v) => v.product)).size} product(s)\n`);

  // match
  const matched = new Map(); // code -> [variant]
  const unmatched = [];
  for (const v of variants) {
    let code = null, method = null;
    if (byCode.has(v.sku)) { code = v.sku; method = 'sku'; }
    else {
      const hit = byTokens.get(tokens(`${v.product} ${v.variant}`));
      if (hit && hit.length === 1) { code = hit[0].ProductCode; method = 'name'; }
    }
    v.code = code; v.method = method;
    if (code) matched.set(code, [...(matched.get(code) || []), v]); else unmatched.push(v);
  }

  // stock by location (50 items per call)
  const levels = new Map();
  const ids = variants.map((v) => v.inventory_item_id);
  for (let i = 0; i < ids.length; i += 50) {
    const { data } = await http.get('/inventory_levels.json', { params: { inventory_item_ids: ids.slice(i, i + 50).join(','), limit: 250 } });
    data.inventory_levels.forEach((l) => levels.set(l.inventory_item_id, [...(levels.get(l.inventory_item_id) || []), l]));
    await sleep(550);
  }
  const { data: locData } = await http.get('/locations.json');
  const locName = Object.fromEntries(locData.locations.map((l) => [l.id, l.name]));
  const perLoc = {};
  levels.forEach((ls) => ls.forEach((l) => { const n = locName[l.location_id] || l.location_id; perLoc[n] = perLoc[n] || { items: 0, available: 0 }; perLoc[n].items++; perLoc[n].available += l.available || 0; }));
  console.log('Stock per Shopify location (variants stocked / total available):');
  Object.entries(perLoc).forEach(([n, s]) => console.log(`  ${n}: ${s.items} variants, ${s.available} units`));

  console.log(`\nMatched ${matched.size} of ${csv.length} Zenoti codes  (by sku: ${variants.filter((v) => v.method === 'sku').length}, by name: ${variants.filter((v) => v.method === 'name').length})`);
  const dup = [...matched].filter(([, vs]) => vs.length > 1);
  if (dup.length) { console.log('\nZenoti codes matching MORE THAN ONE Shopify variant:'); dup.forEach(([c, vs]) => console.log(`  ${c} ${byCode.get(c).ProductName}: ` + vs.map((v) => `${v.product} / ${v.variant}`).join(' | '))); }
  const missing = csv.filter((r) => !matched.has(r.ProductCode));
  console.log(`\nZenoti codes with NO Shopify variant (${missing.length}):`); missing.forEach((r) => console.log(`  ${r.ProductCode}\t${r.ProductName}`));
  console.log(`\nShopify variants NOT matched to any Zenoti code (${unmatched.length}):`);
  unmatched.forEach((v) => console.log(`  [${v.status}] ${v.product} / ${v.variant}  sku="${v.sku}"  qty=${v.qty}`));

  const draft = [...matched].flatMap(([code, vs]) => vs.map((v) => ({ zenotiCode: code, zenotiName: byCode.get(code).ProductName, shopifyProduct: v.product, shopifyVariant: v.variant, variant_id: v.variant_id, inventory_item_id: v.inventory_item_id, sku: v.sku, matchedBy: v.method })));
  fs.writeFileSync('mapping-draft.json', JSON.stringify(draft, null, 2));
  console.log(`\nWrote mapping-draft.json (${draft.length} rows). Paste this whole output back.`);
})().catch((e) => { console.error('Failed:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });