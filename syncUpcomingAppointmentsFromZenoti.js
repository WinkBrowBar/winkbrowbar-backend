// syncUpcomingAppointmentsFromZenoti.js
//
// Zenoti does NOT send a webhook when staff/guest edits an existing
// appointment's date/time in place (confirmed live 2026-10-17: Ava Miner's
// UESR-149 booking was created for Oct 19 2:25pm, Zenoti's own guest
// profile now shows it moved to Oct 18 2:25pm, but RawEvent only has the
// single original AppointmentGroup.Created event - nothing else ever
// arrived). appointmentDate is set once via $setOnInsert and nothing
// refreshes it after that, so any edited-in-place booking goes stale in
// our dashboard forever with no event to ever correct it.
//
// This re-pulls live data from GET /v1/guests/{id}/appointments (confirmed
// shape 2026-10-17 via checkGuestAppointmentsShape.js: appointment_group_id
// + appointment_services[].start_time, where start_time here is CENTER-
// LOCAL wall-clock, same as the webhook's start_time_in_center - NOT the
// same meaning as the webhook's bare start_time field) for every guest
// with a not-yet-visited Appointment, and corrects appointmentDate/
// serviceNames if Zenoti's live data has since diverged from what we
// stored at creation time.
//
// Does NOT paginate (matches lookupGuestAppointments' existing behavior) -
// if a guest has more than one page of appointment history, only the
// first page (most recent, per Zenoti's own default ordering) is checked.
// Logs a warning when page_info says there's more than was returned.
//
// Usage:
//   node syncUpcomingAppointmentsFromZenoti.js --brand=<brandId or slug> [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Appointment = require('./src/db/models/Appointment');
const { lookupGuestAppointments } = require('./src/services/zenotiGuestLookup');
const { centerLocalTimeToUtc } = require('./src/utils/centerTimezone');
const { centerName } = require('./src/utils/centerNames');

const DRY_RUN = process.argv.includes('--dry-run');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  const brandArg = argValue('brand');
  if (!brandArg) {
    console.error('Usage: node syncUpcomingAppointmentsFromZenoti.js --brand=<brandId or slug> [--dry-run]');
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

  // Not-yet-visited, not cancelled/superseded - the "Upcoming Bookings"
  // scope. A 1-day lookback buffer catches same-day bookings that may have
  // just passed their original stored time.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const appointments = await Appointment.find({
    brandId: brand._id,
    status: 'created',
    appointmentDate: { $gte: since },
    zenotiGuestId: { $exists: true, $ne: null },
  });

  console.log(`\n${appointments.length} upcoming appointment(s) to check against live Zenoti data...\n`);

  // Group by guest so a guest with several upcoming bookings costs one API
  // call, not one per appointment.
  const byGuest = new Map();
  for (const appt of appointments) {
    if (!byGuest.has(appt.zenotiGuestId)) byGuest.set(appt.zenotiGuestId, []);
    byGuest.get(appt.zenotiGuestId).push(appt);
  }

  let checked = 0;
  let corrected = 0;
  let lookupFailed = 0;

  for (const [guestId, appts] of byGuest) {
    const liveAppointments = await lookupGuestAppointments(guestId);
    if (!liveAppointments) {
      lookupFailed += appts.length;
      console.log(`  Guest ${guestId}: live lookup failed, skipping ${appts.length} appointment(s).`);
      continue;
    }

    for (const appt of appts) {
      checked++;
      const live = liveAppointments.find((a) => a.appointment_group_id === appt.zenotiAppointmentGroupId);
      if (!live) {
        console.log(`  ${appt.invoiceNumber || appt._id}: NOT found in guest's live appointment list (cancelled in Zenoti without a webhook? verify manually).`);
        continue;
      }

      const services = Array.isArray(live.appointment_services) ? live.appointment_services : [];
      const starts = services.map((s) => s.start_time).filter(Boolean).map((t) => centerLocalTimeToUtc(t)).filter(Boolean);
      const liveAppointmentDate = starts.length ? new Date(Math.min(...starts)) : null;
      const liveServiceNames = services.map((s) => s.service && s.service.name).filter(Boolean);
      const liveCenterName = live.center_id ? (centerName(live.center_id) || appt.centerName) : appt.centerName;

      const dateChanged = liveAppointmentDate && appt.appointmentDate && liveAppointmentDate.getTime() !== appt.appointmentDate.getTime();
      const namesChanged = liveServiceNames.length && JSON.stringify(liveServiceNames) !== JSON.stringify(appt.serviceNames);

      if (!dateChanged && !namesChanged) continue;

      corrected++;
      console.log(`  ${appt.invoiceNumber || appt._id} (${appt.centerName || '—'}):`);
      if (dateChanged) console.log(`    appointmentDate: ${appt.appointmentDate.toISOString()} -> ${liveAppointmentDate.toISOString()}`);
      if (namesChanged) console.log(`    serviceNames: ${JSON.stringify(appt.serviceNames)} -> ${JSON.stringify(liveServiceNames)}`);

      if (!DRY_RUN) {
        const update = {};
        if (dateChanged) update.appointmentDate = liveAppointmentDate;
        if (namesChanged) update.serviceNames = liveServiceNames;
        if (liveCenterName) update.centerName = liveCenterName;
        await Appointment.updateOne({ _id: appt._id }, { $set: update });
      }
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Appointments checked:   ${checked}`);
  console.log(`Corrected:              ${corrected}`);
  console.log(`Guest lookup failed:    ${lookupFailed}`);
  console.log(DRY_RUN ? '\nDry run - nothing written.' : '\nWritten.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});