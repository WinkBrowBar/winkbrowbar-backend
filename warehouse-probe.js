// warehouse-probe.js - standalone, READ-ONLY. Run from winkbrowbar-backend-main (next to .env).
// Reads Zenoti's "Long Island Warehouse" (LW) retail stock and lines it up against
// Shopify's warehouse levels, to show which Zenoti center really feeds which Shopify location.
// Needs in .env: ZENOTI_API_KEY, SHOPIFY_STORE_DOMAIN, SHOPIFY_INVENTORY_CLIENT_ID, SHOPIFY_INVENTORY_CLIENT_SECRET
// Usage: node warehouse-probe.js
require('dotenv').config();
const axios = require('axios');

const LW = 'fcc2c1a0-f6c6-4372-9153-5a5fcb0c6011'; // Zenoti: Long Island Warehouse
const LOCS = {
  'Central-Wink(194 Court)': 62239572083,
  'Backup-Wink(Long Island)': 64147292275,
  'Central-Embr(194 Court)': 89094324339,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ABBR = { db: 'dark brown', dg: 'dark gray', lb: 'light brown' };
const tokens = (s) => String(s || '').toLowerCase().replace(/[®™]/g, '').replace(/[&+]/g, ' and ').replace(/grey/g, 'gray')
  .split(/[^a-z0-9]+/).filter(Boolean).flatMap((t) => (ABBR[t] ? ABBR[t].split(' ') : [t]))
  .filter((t) => !['and', 'with', 'default', 'title'].includes(t)).sort().join(' ');

(async () => {
  for (const k of ['ZENOTI_API_KEY', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_INVENTORY_CLIENT_ID', 'SHOPIFY_INVENTORY_CLIENT_SECRET']) if (!process.env[k]) throw new Error(`${k} missing in .env`);

  // ---- Zenoti: warehouse retail stock
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const { data: zs } = await axios.get(`${process.env.ZENOTI_API_BASE || 'https://api.zenoti.com'}/v1/inventory/stock`, {
    params: { center_id: LW, inventory_date: today, product_type: 1 }, headers: { Authorization: `apikey ${process.env.ZENOTI_API_KEY}` }, timeout: 30000,
  });
  const zen = (zs.list || []).filter((r) => String(r.category || '').trim() === 'Retail');
  console.log(`Zenoti Long Island Warehouse: ${zen.length} retail rows, ${zen.filter((r) => Number(r.total_quantity) > 0).length} with stock > 0, ${zen.filter((r) => Number(r.total_quantity) < 0).length} negative\n`);

  // ---- Shopify: variants (+ vendor), then levels at the 3 warehouse locations
  const shop = process.env.SHOPIFY_STORE_DOMAIN.replace(/\.myshopify\.com$/, '');
  const base = `https://${shop}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION || '2024-10'}`;
  const { data: tk } = await axios.post(`https://${shop}.myshopify.com/admin/oauth/access_token`,
    new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.SHOPIFY_INVENTORY_CLIENT_ID, client_secret: process.env.SHOPIFY_INVENTORY_CLIENT_SECRET }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const headers = { 'X-Shopify-Access-Token': tk.access_token };

  const variants = [];
  let url = `${base}/products.json`; let params = { limit: 250, fields: 'id,title,vendor,status,variants' };
  while (url) {
    const res = await axios.get(url, { headers, params, timeout: 30000 });
    for (const p of res.data.products) {
      if (!['active', 'unlisted'].includes(p.status)) continue;
      for (const v of p.variants) variants.push({ product: p.title, vendor: p.vendor, variant: v.title, sku: v.sku || '', item: v.inventory_item_id });
    }
    const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.link || '');
    url = m ? m[1] : null; params = undefined; await sleep(600);
  }
  const levels = new Map(); // item -> {locName: available}
  const ids = variants.map((v) => v.item);
  for (let i = 0; i < ids.length; i += 50) {
    const res = await axios.get(`${base}/inventory_levels.json`, { headers, timeout: 30000,
      params: { inventory_item_ids: ids.slice(i, i + 50).join(','), location_ids: Object.values(LOCS).join(','), limit: 250 } });
    for (const l of res.data.inventory_levels) {
      const name = Object.keys(LOCS).find((k) => LOCS[k] === l.location_id);
      levels.set(l.inventory_item_id, { ...(levels.get(l.inventory_item_id) || {}), [name]: l.available });
    }
    await sleep(600);
  }

  // ---- line up by NAME (SKUs differ between Embrowerment and Zenoti numbering)
  const byTokens = new Map(); variants.forEach((v) => { const k = tokens(`${v.product} ${v.variant}`); byTokens.set(k, [...(byTokens.get(k) || []), v]); });
  const names = Object.keys(LOCS);
  console.log(['code', 'Zenoti LW', ...names, 'Shopify product / variant [vendor, sku]'].join('\t'));
  let matched = 0, eqCentral = 0, eqBackup = 0;
  for (const r of zen.sort((a, b) => Number(a.product_code) - Number(b.product_code))) {
    const hit = byTokens.get(tokens(r.product_name));
    const v = hit && hit.length === 1 ? hit[0] : null;
    const lv = v ? levels.get(v.item) || {} : {};
    if (v) { matched++; if (lv[names[0]] === Number(r.total_quantity)) eqCentral++; if (lv[names[1]] === Number(r.total_quantity)) eqBackup++; }
    console.log([r.product_code, r.total_quantity, ...names.map((n) => (v ? (lv[n] ?? '-') : '?')), v ? `${v.product} / ${v.variant} [${v.vendor}, sku "${v.sku}"]` : `(no Shopify match) ${r.product_name}`].join('\t'));
  }
  console.log(`\nMatched by name: ${matched} of ${zen.length}. Zenoti LW equals Shopify ${names[0]}: ${eqCentral}, equals ${names[1]}: ${eqBackup}.`);
  console.log('Done. Paste this whole output back.');
})().catch((e) => { console.error('Failed:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });