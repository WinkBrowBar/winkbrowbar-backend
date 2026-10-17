// checkGuestAppointmentsShape.js
//
// Dumps the raw /v1/guests/{id}/appointments response for one guest, so we
// can see the actual field names/shape (does it include start_time_in_center
// like the webhook payload does, or only a UTC-ish start_time?) before
// writing a reconciliation script that trusts this data to correct
// appointmentDate. Avoids repeating the "best-guess field names, not
// confirmed against a real payload" mistake already in zenotiWebhook.js.
//
// Usage: node checkGuestAppointmentsShape.js --guestId=21436fdf-7972-4e87-9f57-3bdee42390d6

require('dotenv').config();
const axios = require('axios');

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  const guestId = argValue('guestId');
  if (!guestId) {
    console.error('Usage: node checkGuestAppointmentsShape.js --guestId=<zenotiGuestId>');
    process.exit(1);
  }
  const { data } = await axios.get(`${ZENOTI_API_BASE}/v1/guests/${guestId}/appointments`, {
    headers: { Authorization: `apikey ${ZENOTI_API_KEY}` },
    timeout: 10000,
  });
  console.log(JSON.stringify(data, null, 2));
})().catch((err) => {
  console.error('Failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});