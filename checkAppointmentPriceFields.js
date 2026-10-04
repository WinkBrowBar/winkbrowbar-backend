// checkAppointmentPriceFields.js
//
// Before adding an estimated $ value to Upcoming Bookings, check whether
// Zenoti's AppointmentGroup.Created webhook payload ever actually includes
// a price field for the services booked - if it does, we should use that
// real number; if it never does (as the one sample we've looked at so far
// suggests), we'll need a different source (e.g. estimate from historical
// closed-invoice prices per service name).
//
// Read-only. Scans a sample of stored appointment.created raw events and
// reports every distinct top-level key seen inside each appointment entry,
// plus flags any key that looks price-related.

require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const RawEvent = require('./src/db/models/RawEvent');

(async () => {
  await connectDB();

  const events = await RawEvent.find({ source: 'zenoti', eventType: 'appointment.created' })
    .sort({ receivedAt: -1 })
    .limit(300)
    .lean();

  console.log(`Scanning ${events.length} appointment.created raw events...\n`);

  const allKeys = new Set();
  let withPriceLikeField = 0;
  let sampleWithPrice = null;

  for (const e of events) {
    const appts = e.payload && e.payload.data && Array.isArray(e.payload.data.appointments)
      ? e.payload.data.appointments
      : [];
    for (const a of appts) {
      Object.keys(a).forEach((k) => allKeys.add(k));
      const priceKeys = Object.keys(a).filter((k) => /price|amount|cost|fee|rate/i.test(k));
      if (priceKeys.length) {
        withPriceLikeField++;
        if (!sampleWithPrice) sampleWithPrice = { keys: priceKeys, appt: a };
      }
    }
  }

  console.log('All distinct keys ever seen on an "appointments[]" entry:');
  console.log([...allKeys].sort().join(', '));
  console.log(`\nEntries with a price-like field: ${withPriceLikeField}`);
  if (sampleWithPrice) {
    console.log('\nSample:', JSON.stringify(sampleWithPrice, null, 2));
  } else {
    console.log('\nNo price-like field found anywhere in the sample - booking-time events do not carry price.');
  }

  process.exit(0);
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });