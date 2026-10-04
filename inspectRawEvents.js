/**
 * Read-only inspection: prints the last few raw Zenoti webhook payloads,
 * so we can see exactly what fields Zenoti sends back (e.g. whether any
 * custom URL params or fields survive from the booking widget into the
 * webhook), and figure out the best way to carry `visitorId` through.
 *
 * Does not modify anything.
 *
 * Usage: node inspectRawEvents.js [eventType] [limit]
 *   node inspectRawEvents.js                       -> last 5 events, any type
 *   node inspectRawEvents.js invoice.closed 3       -> last 3 invoice.closed events
 *   node inspectRawEvents.js guest.created 3
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const RawEvent = require('./src/db/models/RawEvent');

const eventType = process.argv[2];
const limit = Number(process.argv[3]) || 5;

async function run() {
  await connectDB();

  const filter = { source: 'zenoti' };
  if (eventType) filter.eventType = eventType;

  const events = await RawEvent.find(filter).sort({ createdAt: -1 }).limit(limit);

  if (events.length === 0) {
    console.log('No matching raw events found yet. Make a real test booking first.');
  }

  for (const e of events) {
    console.log('\n========================================');
    console.log(`eventType: ${e.eventType}  |  createdAt: ${e.createdAt}  |  processed: ${e.processed}`);
    console.log('----------------------------------------');
    console.log(JSON.stringify(e.payload, null, 2));
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Inspection failed:', err);
  process.exit(1);
});