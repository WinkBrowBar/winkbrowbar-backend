// backfillAppointmentDetails.js
// Fills appointmentDate / serviceNames / centerName / zenotiInvoiceId /
// invoiceNumber / visitId on Appointment docs that were created before
// these fields existed, so old bookings can show up on the Upcoming page
// if their appointment date is still in the future.
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Appointment = require('./src/db/models/Appointment');
const RawEvent = require('./src/db/models/RawEvent');
const Visit = require('./src/db/models/Visit');
const { centerName } = require('./src/utils/centerNames');

(async () => {
  await connectDB();

  const appointments = await Appointment.find({ appointmentDate: null });
  console.log(`Checking ${appointments.length} appointments for missing details...`);

  let fixed = 0;
  for (const appt of appointments) {
    const event = await RawEvent.findOne({
      source: 'zenoti',
      eventType: 'appointment.created',
      'payload.data.appointment_group_id': appt.zenotiAppointmentGroupId,
    }).sort({ receivedAt: -1 });

    const data = event?.payload?.data;
    if (!data) continue;

    const appts = Array.isArray(data.appointments) ? data.appointments : [];
    const serviceNames = appts.map((a) => a.service_name).filter(Boolean);
    const startTimes = appts
      .map((a) => a.start_time_in_center || a.start_time)
      .filter(Boolean)
      .map((t) => new Date(t));
    const appointmentDate = startTimes.length ? new Date(Math.min(...startTimes)) : null;
    if (!appointmentDate) continue;

    const visit = await Visit.findOne({ visitorId: 'zenoti_' + appt.zenotiAppointmentGroupId });

    appt.appointmentDate = appointmentDate;
    appt.serviceNames = serviceNames;
    appt.centerName = data.center_Name || data.center_name || centerName(data.center_id) || null;
    appt.zenotiInvoiceId = data.invoice_id || null;
    appt.invoiceNumber = data.invoice_number ? `${data.invoice_number_prefix || ''}${data.invoice_number}` : null;
    appt.visitId = visit ? visit._id : null;
    await appt.save();
    fixed++;
  }

  console.log(`Backfilled details on ${fixed} of ${appointments.length} appointments.`);
  process.exit(0);
})();