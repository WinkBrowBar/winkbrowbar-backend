// inventory-preview.js - READ-ONLY. Pulls retail stock from all 3 Zenoti centers,
// sums per product (the "all locations" number Shopify would get), and checks
// every code against your Zenoti Products CSV.
// Usage: node inventory-preview.js [path/to/Products.csv]
require('dotenv').config();
const fs = require('fs');
const axios = require('axios');

const BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const KEY = process.env.ZENOTI_API_KEY;
const headers = { Authorization: `apikey ${KEY}` };
const CENTERS = {
  CH: '23c89dee-8285-4c13-b081-12652173dc17',
  WV: 'fe6b4dd3-1c8c-4f6e-84ac-42e6f81a001a',
  UES: '188b010f-a060-4ba9-a5c0-56ffb4339479',
};
const today = new Date().toISOString().slice(0, 10);

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

(async () => {
  if (!KEY) throw new Error('ZENOTI_API_KEY missing');
  const csvPath = process.argv[2] || 'Products.csv';
  const csv = fs.existsSync(csvPath) ? parseCsv(fs.readFileSync(csvPath, 'utf8')) : [];
  const csvCodes = new Map(csv.map((r) => [r.ProductCode, r.ProductName]));
  console.log(csv.length ? `CSV: ${csv.length} products from ${csvPath}` : `No CSV at ${csvPath} - skipping CSV cross-check`);

  const byCode = new Map(); // code -> {name, CH, WV, UES}
  for (const [code, id] of Object.entries(CENTERS)) {
    const { data } = await axios.get(`${BASE}/v1/inventory/stock`, {
      headers, timeout: 30000,
      params: { center_id: id, inventory_date: today, product_type: 1 }, // 1 = Retail
    });
    const list = data.list || [];
    console.log(`${code}: ${list.length} retail row(s)`);
    for (const p of list) {
      const e = byCode.get(p.product_code) || { name: p.product_name, category: p.category, CH: null, WV: null, UES: null };
      e[code] = p.total_quantity;
      byCode.set(p.product_code, e);
    }
  }

  console.log('\ncode\tCH\tWV\tUES\tTOTAL\tname');
  let multiCat = new Set();
  for (const [code, e] of [...byCode].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))) {
    const total = ['CH', 'WV', 'UES'].reduce((s, k) => s + (Number(e[k]) || 0), 0);
    multiCat.add(e.category);
    console.log(`${code}\t${e.CH ?? '-'}\t${e.WV ?? '-'}\t${e.UES ?? '-'}\t${total}\t${e.name}`);
  }
  console.log('\nCategories seen:', [...multiCat].join(' | '));

  if (csvCodes.size) {
    const missing = [...csvCodes].filter(([c]) => !byCode.has(c));
    const extra = [...byCode].filter(([c]) => !csvCodes.has(c));
    console.log(`\nIn CSV but NOT in Zenoti stock (${missing.length}):`);
    missing.forEach(([c, n]) => console.log(`  ${c}\t${n}`));
    console.log(`In Zenoti stock but NOT in CSV (${extra.length}):`);
    extra.forEach(([c, e]) => console.log(`  ${c}\t${e.name}`));
  }
  console.log('\nDone. Paste this whole output back.');
})().catch((e) => { console.error('Failed:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });