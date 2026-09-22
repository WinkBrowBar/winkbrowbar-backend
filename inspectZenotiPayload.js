require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const RawEvent = require('./src/db/models/RawEvent');

(async () => {
  await connectDB();

  // Grab the most recent real (non-test, non-empty) Zenoti invoice-closed event
  const event = await RawEvent.findOne({
    source: 'zenoti',
    eventType: { $regex: /invoice/i },
  }).sort({ receivedAt: -1 });

  if (!event) {
    console.log('No Zenoti invoice events found. Trying any Zenoti event...');
    const any = await RawEvent.findOne({ source: 'zenoti' }).sort({ receivedAt: -1 });
    console.log(JSON.stringify(any, null, 2));
    process.exit(0);
  }

  console.log('eventType:', event.eventType);
  console.log('receivedAt:', event.receivedAt);
  console.log('\nFull payload:\n');
  console.log(JSON.stringify(event.payload, null, 2));
  process.exit(0);
})();