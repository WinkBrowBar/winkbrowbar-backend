// listZenotiProductsFromSales.js
//
// Lists every item Zenoti has actually sold (from the Sales Accrual Report -
// the only endpoint this API key is scoped for) and checks which Shopify
// products show up. Products that never sold won't appear here.
//
// Usage:
//   node listZenotiProductsFromSales.js [--days=730]
require('dotenv').config();
const axios = require('axios');

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;
const REPORT_URL = `${ZENOTI_API_BASE}/v1/reports/sales/accrual_basis/flat_file`;
const MAX_CHUNK_DAYS = 350;

const SHOPIFY_PRODUCTS = [
  'Wink Applicator Brush', 'Power Brow Separator', 'Power Makeup Eraser',
  'Power Hold Brow Styling Wax', 'Embrowerment Precision Pencil', 'Embrowerment Sculpting Pencil',
  'Brow Perfecting Quad', 'Flash Eye Lift Serum', 'Brow + Lash Nourishing Fortifier + Keratin',
  'Power Brow Enhancing Serum', 'Hold Please! Bundle', 'Brows but Sculpted Better Bundle',
  'Brows But Precisely Better Bundle', 'Serum + Sculpt Bundle', 'Precision Power Bundle',
  'Fortify + Sculpt Bundle', 'Fortify + Precision Bundle', 'Lash + Lamination Aftercare Bundle',
  'Tint + Shape Aftercare Bundle', 'Brow Basics Bundle', 'Brows with Benefits Bundle',
];

const argValue = (n) => {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.split('=').slice(1).join('=') : null;
};
const ymd = (d) => d.toISOString().slice(0, 10);
const norm = (s) => String(s || '').toLowerCase().replace(/[®™]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function fetchRows(startDate, endDate) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const { data } = await axios.post(
      REPORT_URL,
      { start_date: startDate, end_date: endDate },
      { params: { Page: page, Size: 200 }, headers: { Authorization: `apikey ${ZENOTI_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    const batch = data.sales || [];
    all.push(...batch);
    const total = data.page_info ? data.page_info.total : batch.length;
    if (all.length >= total || batch.length < 200) return all;
  }
}

async function run() {
  if (!ZENOTI_API_KEY) throw new Error('ZENOTI_API_KEY is not set in .env');
  const days = Number(argValue('days')) || 730;

  const rows = [];
  const end = new Date();
  for (let back = 0; back < days; back += MAX_CHUNK_DAYS) {
    const chunkEnd = new Date(end); chunkEnd.setDate(end.getDate() - back);
    const chunkStart = new Date(end); chunkStart.setDate(end.getDate() - Math.min(back + MAX_CHUNK_DAYS, days));
    process.stdout.write(`Fetching ${ymd(chunkStart)} -> ${ymd(chunkEnd)}... `);
    const batch = await fetchRows(ymd(chunkStart), ymd(chunkEnd));
    console.log(`${batch.length} rows`);
    rows.push(...batch);
  }

  // Show which fields exist so item type can be identified
  if (rows[0]) console.log('\nRow fields:', Object.keys(rows[0]).join(', '));
  const typeKey = rows[0] && Object.keys(rows[0]).find((k) => /item_type|type|category/i.test(k));

  const items = new Map();
  for (const r of rows) {
    const name = r.item_name;
    if (!name) continue;
    const e = items.get(name) || { name, type: typeKey ? r[typeKey] : '', count: 0, lastPrice: r.price, centers: new Set() };
    e.count += 1;
    e.lastPrice = r.price;
    if (r.center_name) e.centers.add(r.center_name);
    items.set(name, e);
  }

  console.log(`\n=== ${items.size} distinct items sold${typeKey ? ` (type field: ${typeKey})` : ''} ===`);
  [...items.values()].sort((a, b) => String(a.type).localeCompare(String(b.type)) || a.name.localeCompare(b.name))
    .forEach((e) => console.log(`${e.type || '-'}\t${e.name}\t$${e.lastPrice}\tx${e.count}\t${[...e.centers].join(' | ')}`));

  console.log('\n=== Shopify products vs Zenoti sales ===');
  const soldNorm = [...items.values()].map((e) => ({ e, n: norm(e.name) }));
  for (const p of SHOPIFY_PRODUCTS) {
    const pn = norm(p);
    const hit = soldNorm.find(({ n }) => n === pn) || soldNorm.find(({ n }) => n.includes(pn) || pn.includes(n));
    console.log(hit ? `FOUND    ${p}  ->  "${hit.e.name}" $${hit.e.lastPrice}` : `MISSING  ${p}`);
  }
}

run().catch((err) => {
  console.error('Failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});