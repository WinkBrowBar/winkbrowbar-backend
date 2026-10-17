// checkMissingGroup.js
// Usage: node checkMissingGroup.js --groupId=1a5b750a-55a4-4595-bc80-5faf057d68e4
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Appointment = require('./src/db/models/Appointment');
const RawEvent = require('./src/db/models/RawEvent');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  await connectDB();
  const groupId = argValue('groupId');

  const appt = await Appointment.findOne({ zenotiAppointmentGroupId: groupId }).lean();
  console.log('Appointment doc for this group:', appt || '(none found - this booking does not exist in our db at all)');

  const events = await RawEvent.find({ source: 'zenoti' }).sort({ receivedAt: 1 }).lean();
  const matches = events.filter((e) => JSON.stringify(e.payload).includes(groupId));
  console.log(`\n${matches.length} raw event(s) mentioning this group id anywhere in the payload.`);
  for (const e of matches) {
    console.log(`  ${e.eventType} @ ${e.receivedAt}`);
  }

  process.exit(0);
})();