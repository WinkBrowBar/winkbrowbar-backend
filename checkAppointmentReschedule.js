// checkAppointmentReschedule.js
//
// For a given invoice number (e.g. UESR-149), finds the matching
// Appointment doc and every raw Zenoti webhook event tied to its
// appointment group, so we can see:
//   - what appointmentDate/wasRescheduled/originalAppointmentDate we
//     currently have stored
//   - the ACTUAL raw payload Zenoti sent for any appointment.status_changed
//     event on it, to confirm/correct the best-guess field names in
//     zenotiWebhook.js (is_appointment_rescheduled, initial_appointment_start_time, etc.)
//
// Usage:
//   node checkAppointmentReschedule.js --brand=<brandId or slug> --invoice=UESR-149

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Appointment = require('./src/db/models/Appointment');
const RawEvent = require('./src/db/models/RawEvent');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  const brandArg = argValue('brand');
  const invoiceNumber = argValue('invoice');
  if (!brandArg || !invoiceNumber) {
    console.error('Usage: node checkAppointmentReschedule.js --brand=<brandId or slug> --invoice=UESR-149');
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

  const appt = await Appointment.findOne({ brandId: brand._id, invoiceNumber }).lean();
  if (!appt) {
    console.log(`No Appointment found with invoiceNumber "${invoiceNumber}". Trying a loose match...`);
    const loose = await Appointment.find({ brandId: brand._id, invoiceNumber: { $regex: invoiceNumber, $options: 'i' } }).lean();
    console.log(JSON.stringify(loose, null, 2));
    process.exit(0);
  }

  console.log('Appointment doc:');
  console.log(JSON.stringify(appt, null, 2));

  const groupId = appt.zenotiAppointmentGroupId;
  console.log(`\nLooking up raw Zenoti events for appointment_group_id = ${groupId}...\n`);

  const events = await RawEvent.find({
    source: 'zenoti',
    $or: [
      { 'payload.data.appointment_group_id': groupId },
      { 'payload.data.appointments.appointment_group_id': groupId },
    ],
  }).sort({ receivedAt: 1 }).lean();

  if (!events.length) {
    console.log('No raw events matched that exact query shape - dumping ALL recent appointment-ish events instead so we can see the real field layout:');
    const recent = await RawEvent.find({ source: 'zenoti', eventType: { $regex: /appointment/i } }).sort({ receivedAt: -1 }).limit(10).lean();
    for (const e of recent) {
      console.log(`\n--- ${e.eventType} @ ${e.receivedAt} ---`);
      console.log(JSON.stringify(e.payload, null, 2));
    }
  } else {
    for (const e of events) {
      console.log(`\n--- ${e.eventType} @ ${e.receivedAt} ---`);
      console.log(JSON.stringify(e.payload, null, 2));
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});