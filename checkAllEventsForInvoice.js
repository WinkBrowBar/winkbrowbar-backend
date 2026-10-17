// checkAllEventsForInvoice.js
//
// Broader than checkAppointmentReschedule.js - searches ALL RawEvents for
// this brand that mention a given invoice id, guest id, or appointment
// group id ANYWHERE in the raw payload (not assuming a specific nested
// path), regardless of eventType/detectedType. Used to confirm whether
// Zenoti ever sent a second event for a booking after the initial
// AppointmentGroup.Created - e.g. an in-place time edit that our
// detectEventType()/handleEvent() might not recognize or might not be
// matching on the right field path.
//
// Usage:
//   node checkAllEventsForInvoice.js --brand=<brandId or slug> --match=f9ff9f84-6a73-4eeb-96a3-4edda235c70a

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const RawEvent = require('./src/db/models/RawEvent');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  const brandArg = argValue('brand');
  const needle = argValue('match');
  if (!brandArg || !needle) {
    console.error('Usage: node checkAllEventsForInvoice.js --brand=<brandId or slug> --match=<id to search for>');
    process.exit(1);
  }

  await connectDB();

  const brand = mongoose.isValidObjectId(brandArg)
    ? await Brand.findById(brandArg)
    : await Brand.findOne({ slug: brandArg });
  if (!brand) {
    console.error(`No brand found for "${brandArg}"`);
    process.exit(1);
  }

  const since = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const events = await RawEvent.find({
    brandId: brand._id,
    source: 'zenoti',
    receivedAt: { $gte: since },
  }).sort({ receivedAt: 1 }).lean();

  console.log(`Scanning ${events.length} zenoti RawEvent(s) from the last 10 days for "${needle}"...\n`);

  const matches = events.filter((e) => JSON.stringify(e.payload).includes(needle));
  console.log(`${matches.length} matching event(s):\n`);
  for (const e of matches) {
    console.log(`--- ${e.eventType} (raw event_type: ${e.payload && e.payload.event_type}) @ ${e.receivedAt}  processed=${e.processed}  processingError=${e.processingError || 'none'} ---`);
    console.log(JSON.stringify(e.payload, null, 2));
    console.log();
  }

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});