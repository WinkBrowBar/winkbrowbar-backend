// checkZenotiAppointmentPrice.js  (read-only)
// Shows where Zenoti's /v1/guests/{id}/appointments puts the price, and what
// bookedPriceFromLiveAppointment() reads from it.
// Usage: node checkZenotiAppointmentPrice.js --guest=<zenotiGuestId>
require('dotenv').config();
const { lookupGuestAppointmentsAllPages, bookedPriceFromLiveAppointment } = require('./src/services/zenotiGuestLookup');

const guest = (process.argv.find((a) => a.startsWith('--guest=')) || '').split('=')[1];
if (!guest) { console.error('Usage: node checkZenotiAppointmentPrice.js --guest=<zenotiGuestId>'); process.exit(1); }

const priceish = (o, prefix = '') => {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o)) {
    const key = prefix + k;
    if (/price|amount|cost|tax|final|sales|discount|total/i.test(k)) out[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, priceish(v, key + '.'));
  }
  return out;
};

(async () => {
  const appts = await lookupGuestAppointmentsAllPages(guest);
  if (!appts) { console.error('Lookup failed (check ZENOTI_API_KEY)'); process.exit(1); }
  for (const a of appts) {
    console.log(`\n=== group ${a.appointment_group_id}  invoice ${a.invoice_id || '-'}  status ${a.status ?? '-'}`);
    console.log('  group price fields:', JSON.stringify(priceish(a, '')));
    (a.appointment_services || []).forEach((s, i) => console.log(`  service[${i}] ${s.service && s.service.name}:`, JSON.stringify(priceish(s))));
    console.log('  -> bookedPrice read by sync:', bookedPriceFromLiveAppointment(a));
  }
})();