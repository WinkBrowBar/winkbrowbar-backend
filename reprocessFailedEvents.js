// reprocessFailedEvents.js
//
// Finds every Zenoti RawEvent that never finished processing successfully
// (processed: false) and retries it through the exact same handleEvent()
// logic the live webhook uses. This is what actually prevents a webhook
// event that failed on our side (bug, transient DB error, etc.) from being
// lost forever - previously such a failure only ever showed up in a
// console.log nobody was watching, and nothing ever retried it.
//
// Safe to run repeatedly: Invoice/Appointment/Customer writes inside
// handleEvent() are upserts, so reprocessing an already-partially-applied
// event does not create duplicates.
//
// This does NOT catch webhook deliveries that never reached us at all
// (network failure, Zenoti-side delivery issue) - there is no row to
// retry in that case, since nothing was ever received. That gap needs a
// separate reconciliation job pulling directly from Zenoti's own API,
// which requires Zenoti API credentials this codebase doesn't have yet.
//
// Usage:
//   node reprocessFailedEvents.js            # process everything unprocessed
//   node reprocessFailedEvents.js 3           # only retry events with < 3 prior attempts
//
// Meant to be run on a schedule (cron/pm2), not just by hand - see the
// crontab line suggested at the end of its output.

require('dotenv').config();
const { connectDB, mongoose } = require('./src/db/connection');
const RawEvent = require('./src/db/models/RawEvent');
const { handleEvent } = require('./src/webhooks/zenotiWebhook');

(async () => {
  const maxAttempts = process.argv[2] ? Number(process.argv[2]) : null;

  await connectDB();

  const query = { processed: false };
  if (maxAttempts !== null) {
    query.processingAttempts = { $lt: maxAttempts };
  }

  const pending = await RawEvent.find(query).sort({ receivedAt: 1 });

  if (!pending.length) {
    console.log('Nothing to reprocess - no unprocessed RawEvents found' + (maxAttempts !== null ? ` under ${maxAttempts} attempts` : '') + '.');
    process.exit(0);
  }

  console.log(`Found ${pending.length} unprocessed event(s). Retrying...\n`);

  let succeeded = 0;
  let failed = 0;

  for (const rawEvent of pending) {
    try {
      await handleEvent(String(rawEvent.brandId), rawEvent.payload);
      rawEvent.processed = true;
      rawEvent.processedAt = new Date();
      rawEvent.processingError = null;
      await rawEvent.save();
      succeeded++;
      console.log(`OK    ${rawEvent._id} (${rawEvent.eventType}, received ${rawEvent.receivedAt.toISOString()})`);
    } catch (err) {
      rawEvent.processingError = err.message || String(err);
      rawEvent.processingAttempts = (rawEvent.processingAttempts || 0) + 1;
      rawEvent.lastAttemptAt = new Date();
      await rawEvent.save();
      failed++;
      console.log(`FAIL  ${rawEvent._id} (${rawEvent.eventType}, received ${rawEvent.receivedAt.toISOString()}) - ${err.message}`);
    }
  }

  console.log(`\nDone. ${succeeded} recovered, ${failed} still failing.`);
  if (failed > 0) {
    console.log('Events still failing after retry need a real look - run this again after checking the error, or share the processingError text.');
  }
  console.log('\nTo run this automatically, add to crontab (every 15 min):');
  console.log('  */15 * * * * cd ' + __dirname + ' && /usr/bin/node reprocessFailedEvents.js >> reprocess.log 2>&1');

  process.exit(0);
})().catch((err) => {
  console.error('Script failed:', err.message);
  process.exit(1);
});