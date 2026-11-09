// probe-zenoti.js - read-only. Tries each Zenoti endpoint separately so we can
// see exactly which ones this API key is allowed to call.
// Usage: node probe-zenoti.js
require('dotenv').config();
const axios = require('axios');

const BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const KEY = process.env.ZENOTI_API_KEY;
const headers = { Authorization: `apikey ${KEY}` };

// Center IDs from src/utils/centerNames.js
const CENTERS = {
  'Cobble Hill': '23c89dee-8285-4c13-b081-12652173dc17',
  'West Village': 'fe6b4dd3-1c8c-4f6e-84ac-42e6f81a001a',
  'Upper East Side': '188b010f-a060-4ba9-a5c0-56ffb4339479',
};
const today = new Date().toISOString().slice(0, 10);

async function probe(label, path, params) {
  try {
    const { data } = await axios.get(`${BASE}${path}`, { headers, params, timeout: 20000 });
    const preview = JSON.stringify(data).slice(0, 300);
    console.log(`OK    ${label}\n      ${preview}\n`);
    return data;
  } catch (e) {
    const status = e.response ? e.response.status : 'no-response';
    const body = e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    console.log(`FAIL  ${label}  [${status}]\n      ${body}\n`);
    return null;
  }
}

(async () => {
  if (!KEY) { console.error('ZENOTI_API_KEY missing'); process.exit(1); }
  console.log(`Base: ${BASE}  key length: ${KEY.length}\n`);

  await probe('CONTROL guests/search (known to work in backend)', '/v1/guests/search', { email: 'test@example.com' });
  await probe('GET /v1/centers', '/v1/centers', {});

  for (const [name, id] of Object.entries(CENTERS)) {
    await probe(`${name}: inventory/stock`, '/v1/inventory/stock', { center_id: id, inventory_date: today, product_type: 3 });
    await probe(`${name}: centers/{id}/products`, `/v1/centers/${id}/products`, { page: 1, size: 5 });
  }
  console.log('Done. Paste this whole output back.');
})();