// backfillAppointmentBookedAt.js
// The earlier backfillAppointmentDetails.js run already filled in
// appointmentDate/serviceNames/etc, so it won't touch those rows again.
// This just adds the new bookedAt field (from the original booking event's
// timestamp) to any Appointment still missing it.
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Appointment = require('./src/db/models/Appointment');
const RawEvent = require('./src/db/models/RawEvent');

(async () => {
  await connectDB();

  const appointments = await Appointment.find({ bookedAt: null });
  console.log(`Checking ${appointments.length} appointments for missing bookedAt...`);

  let fixed = 0;
  for (const appt of appointments) {
    const event = await RawEvent.findOne({
      source: 'zenoti',
      eventType: 'appointment.created',
      'payload.data.appointment_group_id': appt.zenotiAppointmentGroupId,
    }).sort({ receivedAt: -1 });

    // event_timestamp lives on the top-level payload, not inside payload.data.
    const timestamp = event?.payload?.event_timestamp;
    if (!timestamp) continue;

    appt.bookedAt = new Date(timestamp);
    await appt.save();
    fixed++;
  }

  console.log(`Backfilled bookedAt on ${fixed} of ${appointments.length} appointments.`);
  process.exit(0);
})();