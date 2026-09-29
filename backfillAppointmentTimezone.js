// backfillAppointmentTimezone.js
//
// zenotiWebhook.js had a bug: it parsed Zenoti's "start_time_in_center"
// (a naive local time string, e.g. "2026-09-29T12:00:00", no timezone
// offset) with plain `new Date(...)`, which treats it as UTC. It's really
// wall-clock time at the center (Eastern) - so every stored
// Appointment.appointmentDate has been off by the Eastern/UTC offset
// (4-5 hours depending on DST) since this system started recording them.
//
// This re-reads the original "appointment.created" RawEvent for every
// Appointment record, recomputes the correct appointmentDate with the
// fixed timezone conversion, and updates it. Appointments whose raw event
// is missing (never stored, or purged) are skipped and listed.
//
// Dry-run by default - prints every change without writing.
// Pass --apply to actually update the records.
//
// Usage:
//   node backfillAppointmentTimezone.js
//   node backfillAppointmentTimezone.js --apply

require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Appointment = require('./src/db/models/Appointment');
const RawEvent = require('./src/db/models/RawEvent');
const { centerLocalTimeToUtc } = require('./src/utils/centerTimezone');

const apply = process.argv.includes('--apply');

(async () => {
  await connectDB();

  const appointments = await Appointment.find({ appointmentDate: { $ne: null } }).lean();
  console.log(`\nChecking ${appointments.length} appointment(s)...\n`);

  let fixed = 0;
  let alreadyCorrect = 0;
  let noRawEvent = 0;

  for (const appt of appointments) {
    // Find this appointment's original creation event by group id, the same
    // way checkRawEventsWV25258.js did - $regex can't search inside the
    // Mixed payload field, so filter in JS instead.
    const candidates = await RawEvent.find({
      source: 'zenoti',
      eventType: 'appointment.created',
    }).lean();

    const match = candidates.find(
      (e) => e.payload && e.payload.data && e.payload.data.appointment_group_id === appt.zenotiAppointmentGroupId,
    );

    if (!match) {
      console.log(`${appt.invoiceNumber || appt.zenotiAppointmentGroupId} -> no raw event found, skipped`);
      noRawEvent++;
      continue;
    }

    const appts = Array.isArray(match.payload.data.appointments) ? match.payload.data.appointments : [];
    const correctTimes = appts
      .map((a) => a.start_time_in_center || a.start_time)
      .filter(Boolean)
      .map((t) => centerLocalTimeToUtc(t))
      .filter(Boolean);

    if (!correctTimes.length) {
      console.log(`${appt.invoiceNumber || appt.zenotiAppointmentGroupId} -> raw event has no usable start time, skipped`);
      noRawEvent++;
      continue;
    }

    const correctDate = new Date(Math.min(...correctTimes.map((d) => d.getTime())));
    const storedDate = new Date(appt.appointmentDate);

    if (correctDate.getTime() === storedDate.getTime()) {
      alreadyCorrect++;
      continue;
    }

    console.log(
      `${(appt.invoiceNumber || appt.zenotiAppointmentGroupId).padEnd(12)} | stored: ${storedDate.toISOString()} -> correct: ${correctDate.toISOString()}`,
    );
    fixed++;

    if (apply) {
      await Appointment.updateOne({ _id: appt._id }, { $set: { appointmentDate: correctDate } });
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`${apply ? 'Fixed' : 'Would fix'}: ${fixed}`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`No raw event to recompute from: ${noRawEvent}`);
  if (!apply && fixed > 0) console.log(`\nDry run only - re-run with --apply to actually write these changes.`);

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});