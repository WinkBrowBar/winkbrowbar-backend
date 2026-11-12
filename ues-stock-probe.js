// ues-stock-probe.js - standalone, READ-ONLY. Why does the dashboard show UES stock that differs from
// Zenoti's Current Stock report (e.g. Applicator Brush code 42: report 78, API-based dashboard -7)?
// Dumps every raw /v1/inventory/stock row for one product code at UES (and CH for comparison),
// across product types and dates, plus paging info and duplicate rows.
//
// Usage (from the backend folder, uses ZENOTI_API_KEY from .env):  node ues-stock-probe.js 42
require('dotenv').config();
const axios = require('axios');

const CODE = String(process.argv[2] || '42');
const CENTERS = { UES: '188b010f-a060-4ba9-a5c0-56ffb4339479', CH: '23c89dee-8285-4c13-b081-12652173dc17' };
const base = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com'; // same base the sync (src/inventory/clients.js) uses
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ny = (offsetDays = 0) => new Date(Date.now() + offsetDays * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function stock(centerId, params) {
  await sleep(1500); // stay under Zenoti's rate limit
  try {
    const { data } = await axios.get(`${base}/v1/inventory/stock`, {
      params: { center_id: centerId, ...params }, timeout: 30000,
      headers: { Authorization: `apikey ${process.env.ZENOTI_API_KEY}` },
    });
    return data;
  } catch (e) { return { error: e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message }; }
}

(async () => {
  if (!process.env.ZENOTI_API_KEY) throw new Error('ZENOTI_API_KEY missing in .env');
  const today = ny(0); const tomorrow = ny(1);
  const runs = [
    ['UES', { inventory_date: today, product_type: 1 }],   // exactly what the sync uses
    ['UES', { inventory_date: tomorrow, product_type: 1 }], // in case the API returns start-of-day stock
    ['UES', { inventory_date: today }],                     // no product_type filter
    ['UES', { inventory_date: today, product_type: 3 }],
    ['CH', { inventory_date: today, product_type: 1 }],    // CH matches the report - for comparison
  ];
  for (const [name, params] of runs) {
    const data = await stock(CENTERS[name], params);
    console.log(`\n=== ${name} ${JSON.stringify(params)}`);
    if (data.error) { console.log('  ERROR', data.error); continue; }
    const list = data.list || [];
    const extra = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'list'));
    console.log(`  rows: ${list.length} | other response fields: ${JSON.stringify(extra)}`);
    const dupCodes = Object.entries(list.reduce((m, r) => ((m[r.product_code] = (m[r.product_code] || 0) + 1), m), {})).filter(([, n]) => n > 1);
    console.log(`  product codes appearing more than once: ${dupCodes.length ? JSON.stringify(dupCodes.slice(0, 15)) : 'none'}`);
    const hits = list.filter((r) => String(r.product_code) === CODE);
    console.log(`  rows for code ${CODE}: ${hits.length}`);
    hits.forEach((r) => console.log('  ', JSON.stringify(r)));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });