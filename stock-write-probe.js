// stock-write-probe.js - tests Zenoti PUT /v1/products/{product_id}/stock on ONE product at ONE center.
// Run from winkbrowbar-backend-main (next to .env). Needs ZENOTI_API_KEY.
//
// Dry run (default): reads stock, prints exactly what it WOULD send. Changes nothing.
//   node stock-write-probe.js --center=CH --code=24
// Real test:
//   node stock-write-probe.js --center=CH --code=24 --apply
//
// What --apply does: sends quantity = current+1, reads back, works out whether Zenoti treats
// "quantity" as SET (new = current+1) or ADD (new = current + current+1), then undoes the change.
// Pick a product whose current stock at that center is 2 or more (so SET and ADD give different results).
require('dotenv').config();
const axios = require('axios');

const CENTERS = {
  CH: '23c89dee-8285-4c13-b081-12652173dc17',
  WV: 'fe6b4dd3-1c8c-4f6e-84ac-42e6f81a001a',
  UES: '188b010f-a060-4ba9-a5c0-56ffb4339479',
};
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const apply = process.argv.includes('--apply');
const BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const headers = { Authorization: `apikey ${process.env.ZENOTI_API_KEY}`, 'Content-Type': 'application/json' };

async function readRow(centerId, code) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const { data } = await axios.get(`${BASE}/v1/inventory/stock`, {
    params: { center_id: centerId, inventory_date: today, product_type: 1 }, headers, timeout: 30000,
  });
  return (data.list || []).find((r) => String(r.product_code) === String(code) && String(r.category || '').trim() === 'Retail');
}
async function put(productId, centerId, quantity, reason) {
  const body = { center_id: centerId, quantity, reason };
  console.log(`PUT /v1/products/${productId}/stock`, JSON.stringify(body));
  const res = await axios.put(`${BASE}/v1/products/${productId}/stock`, body, { headers, timeout: 30000, validateStatus: () => true });
  console.log(`  -> HTTP ${res.status}`, JSON.stringify(res.data));
  return res;
}

(async () => {
  if (!process.env.ZENOTI_API_KEY) throw new Error('ZENOTI_API_KEY missing in .env');
  const centerId = CENTERS[arg('center')]; const code = arg('code');
  if (!centerId || !code) throw new Error('Usage: node stock-write-probe.js --center=CH|WV|UES --code=<zenoti product code> [--apply]');

  const row = await readRow(centerId, code);
  if (!row) throw new Error(`Product code ${code} not found at ${arg('center')}`);
  const cur = Number(row.total_quantity);
  // stock rows carry no product id -> look it up in the center's product list (by code, then by name)
  let productId = null; const seen = [];
  for (let page = 1; page <= 10 && !productId; page++) {
    const { data } = await axios.get(`${BASE}/v1/centers/${centerId}/products`, { params: { page, size: 100 }, headers, timeout: 30000 });
    const list = data.products || data.list || data.items || (Array.isArray(data) ? data : []);
    if (!list.length) { if (page === 1) console.log(`Products response keys: ${Object.keys(data).join(', ')}`); break; }
    if (page === 1) console.log(`Product item keys: ${Object.keys(list[0]).join(', ')}`);
    seen.push(...list);
    const norm = (s) => String(s || '').trim().toLowerCase();
    const hit = list.find((p) => String(p.code ?? p.product_code ?? '') === String(code) && (p.id || p.product_id))
      || list.find((p) => norm(p.name ?? p.product_name) === norm(row.product_name) && (p.id || p.product_id));
    if (hit) productId = hit.id || hit.product_id;
    if (list.length < 100) break;
  }
  console.log(`${row.product_name} @ ${arg('center')}: current total_quantity = ${cur}, product_id = ${productId}`);
  if (!productId) throw new Error(`Could not find a product id (looked through ${seen.length} products) - paste the "Product item keys" line back to me.`);

  if (!apply) { console.log(`\nDRY RUN. With --apply I would send quantity=${cur + 1}, read back, then undo. Nothing changed.`); return; }
  if (cur < 2) throw new Error('Pick a product with current stock >= 2 at this center (so SET vs ADD can be told apart).');

  console.log('\nStep 1: send current+1');
  const r1 = await put(productId, centerId, cur + 1, 'API test +1 (will be undone)');
  if (r1.status >= 300) { console.log('Write rejected. Nothing changed. Paste this output back.'); return; }
  const after = await readRow(centerId, code);
  const now = Number(after.total_quantity);
  console.log(`Read back from Zenoti: ${now}  (response said new_quantity=${r1.data && r1.data.new_quantity})`);

  let mode;
  if (now === cur + 1) mode = 'SET';
  else if (now === cur + (cur + 1)) mode = 'ADD';
  else mode = 'UNKNOWN';
  console.log(`Zenoti treats "quantity" as: ${mode}`);

  console.log('\nStep 2: undo');
  if (mode === 'SET') await put(productId, centerId, cur, 'API test undo');
  else if (mode === 'ADD') await put(productId, centerId, -(cur + 1), 'API test undo');
  else { console.log(`UNKNOWN result. Original was ${cur}, now ${now}. Fix manually in Zenoti if needed and paste this output back.`); return; }
  const fin = await readRow(centerId, code);
  console.log(`Final stock: ${fin.total_quantity} (original ${cur}) -> ${Number(fin.total_quantity) === cur ? 'RESTORED OK' : 'NOT RESTORED, fix manually in Zenoti'}`);
  console.log('Done. Paste this whole output back.');
})().catch((e) => { console.error('Failed:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });