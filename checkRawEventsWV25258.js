require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const RawEvent = require('./src/db/models/RawEvent');

(async () => {
  await connectDB();

  const groupId = 'aae386ee-2428-4c5a-b9ad-d5c5620b96cb';

  // Mongo $regex can't match inside a Mixed/object field directly - that
  // was the bug in the last version (matched 0 because payload is a
  // subdocument, not a string). Instead, pull a window of raw zenoti
  // events around when this booking was created and filter in JS by
  // stringifying each payload.
  const windowStart = new Date('2026-09-28T19:00:00.000Z');
  const windowEnd = new Date('2026-09-29T13:00:00.000Z');

  const candidates = await RawEvent.find({
    source: 'zenoti',
    receivedAt: { $gte: windowStart, $lte: windowEnd },
  }).sort({ receivedAt: 1 }).lean();

  console.log(`Scanning ${candidates.length} raw zenoti event(s) received in this window...\n`);

  const matches = candidates.filter((e) => JSON.stringify(e.payload).includes(groupId));

  console.log(`Found ${matches.length} event(s) mentioning appointment group ${groupId}:\n`);
  for (const e of matches) {
    console.log('---');
    console.log('eventType:', e.eventType);
    console.log('receivedAt:', e.receivedAt);
    console.log('processed:', e.processed, '| processingError:', e.processingError);
    console.log('payload:', JSON.stringify(e.payload).slice(0, 3000));
  }

  if (matches.length === 0) {
    console.log('(none matched by group id - listing all eventTypes seen in this window instead, for context)');
    const types = {};
    for (const e of candidates) { types[e.eventType] = (types[e.eventType] || 0) + 1; }
    console.log(types);
  }

  process.exit(0);
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });