// checkZenotiGuestHistory.js
//
// Investigates a real failure: Cynthia Johnson (cynthia.johnson.ny@gmail.com,
// invoice WV25491) has a March 2024 purchase (WV6688) visible in Zenoti's
// own "Past Treatments" tab, but our live check tagged her latest invoice
// "New" anyway - meaning guest.created_date did NOT reflect her real first
// visit. This looks up her guest record AND tries to find an endpoint that
// returns her actual appointment/visit history, to see what Zenoti really
// has and whether there's a more reliable field/endpoint than created_date.
//
// Usage:
//   node checkZenotiGuestHistory.js someone@example.com

require('dotenv').config();
const axios = require('axios');

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;
const headers = { Authorization: `apikey ${ZENOTI_API_KEY}` };

async function tryGet(label, url, params) {
  console.log(`\n--- ${label}: GET ${url}${params ? '?' + new URLSearchParams(params) : ''} ---`);
  try {
    const { data } = await axios.get(url, { params, headers, timeout: 10000 });
    console.log('SUCCESS. Raw response:');
    console.log(JSON.stringify(data, null, 2).slice(0, 4000));
    return data;
  } catch (err) {
    console.log('FAILED:', err.response ? JSON.stringify(err.response.data) : err.message);
    return null;
  }
}

(async () => {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node checkZenotiGuestHistory.js someone@example.com');
    process.exit(1);
  }
  if (!ZENOTI_API_KEY) {
    console.error('ZENOTI_API_KEY is not set in .env');
    process.exit(1);
  }

  const searchResult = await tryGet('Guest search', `${ZENOTI_API_BASE}/v1/guests/search`, { email });
  const guest = searchResult && searchResult.guests && searchResult.guests[0];
  if (!guest) {
    console.log('\nNo guest found for that email - stopping.');
    process.exit(1);
  }

  console.log(`\nFound guest id=${guest.id}, created_date=${guest.created_date}, center_id=${guest.center_id}`);

  // Candidate endpoints that might return real appointment/visit history,
  // tried in order - printing whichever ones actually work.
  await tryGet('Guest appointments (v1)', `${ZENOTI_API_BASE}/v1/guests/${guest.id}/appointments`);
  await tryGet('Guest appointment history (v1, with dates)', `${ZENOTI_API_BASE}/v1/guests/${guest.id}/appointments`, {
    start_date: '2020-01-01',
    end_date: new Date().toISOString().slice(0, 10),
  });
  await tryGet('Appointments by guest_id query param', `${ZENOTI_API_BASE}/v1/appointments`, { guest_id: guest.id });
  await tryGet('Guest full details (may include visit stats)', `${ZENOTI_API_BASE}/v1/guests/${guest.id}`);

  process.exit(0);
})();