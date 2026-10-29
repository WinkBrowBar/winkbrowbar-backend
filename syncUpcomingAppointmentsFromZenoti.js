// syncUpcomingAppointmentsFromZenoti.js
//
// Zenoti does NOT send a webhook when staff/guest edits an existing
// appointment's date/time in place, OR when one gets cancelled (confirmed
// live 2026-10-17: Ava Miner's UESR-149 booking was created for Oct 19
// 2:25pm, Zenoti's own guest profile later showed it moved to Oct 18
// 2:25pm, but RawEvent only ever had the single original
// AppointmentGroup.Created event; separately, of 250 upcoming bookings
// checked, ~231 came back absent from their guest's live appointment list
// entirely - real cancellations Zenoti never webhooked, e.g. WV24898).
// appointmentDate/status are set once via $setOnInsert and nothing
// refreshes them after that, so any edited-in-place or cancelled booking
// goes stale in our dashboard forever with no event to ever correct it.
//
// This re-pulls live data from GET /v1/guests/{id}/appointments via
// lookupGuestAppointmentsAllPages (src/services/zenotiGuestLookup.js -
// pages through page_info.total rather than trusting page 1 alone, which
// a first version of this script didn't do and which would otherwise
// wrongly call a guest's real upcoming booking "cancelled" just because
// they have more than 10 appointments in their history) for every guest
// with a not-yet-visited Appointment, and:
//   - corrects appointmentDate/serviceNames/centerName if Zenoti's live
//     data has since diverged from what we stored at creation time
//   - marks an appointment CANCELLED if, after checking every page, its
//     appointment_group_id genuinely isn't in the guest's live list at all
//
// Meant to run both ad hoc (CLI) and on a schedule (imported by
// src/scheduler.js). Loops every brand when no --brand is given, which is
// what the scheduled run does.
//
// Usage:
//   node syncUpcomingAppointmentsFromZenoti.js [--brand=<brandId or slug>] [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Appointment = require('./src/db/models/Appointment');
const { lookupGuestAppointmentsAllPages, bookedPriceFromLiveAppointment } = require('./src/services/zenotiGuestLookup');
const { centerLocalTimeToUtc } = require('./src/utils/centerTimezone');
const { centerName } = require('./src/utils/centerNames');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

// The reusable core, called per-brand. Returns the summary counts so a
// caller (CLI below, or the scheduler) can log/aggregate them.
async function syncBrand(brand, { dryRun = false, log = console.log } = {}) {
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

  log(`\n[${brand.slug || brand._id}] ${appointments.length} upcoming appointment(s) to check against live Zenoti data...\n`);

  // Group by guest so a guest with several upcoming bookings costs one API
  // call (or a handful, if paginated), not one per appointment.
  const byGuest = new Map();
  for (const appt of appointments) {
    if (!byGuest.has(appt.zenotiGuestId)) byGuest.set(appt.zenotiGuestId, []);
    byGuest.get(appt.zenotiGuestId).push(appt);
  }

  let checked = 0;
  let corrected = 0;
  let cancelled = 0;
  let lookupFailed = 0;

  for (const [guestId, appts] of byGuest) {
    const liveAppointments = await lookupGuestAppointmentsAllPages(guestId);
    if (!liveAppointments) {
      lookupFailed += appts.length;
      log(`  Guest ${guestId}: live lookup failed, skipping ${appts.length} appointment(s).`);
      continue;
    }

    for (const appt of appts) {
      checked++;
      const live = liveAppointments.find((a) => a.appointment_group_id === appt.zenotiAppointmentGroupId);

      if (!live) {
        cancelled++;
        log(`  ${appt.invoiceNumber || appt._id}: genuinely absent from guest's full live appointment history (${liveAppointments.length} checked) - marking cancelled.`);
        if (!dryRun) {
          await Appointment.updateOne(
            { _id: appt._id },
            { $set: { status: 'cancelled', cancelledAt: new Date(), zenotiStatus: 'not_found_in_live_history' } },
          );
        }
        continue;
      }

      const services = Array.isArray(live.appointment_services) ? live.appointment_services : [];
      const starts = services.map((s) => s.start_time).filter(Boolean).map((t) => centerLocalTimeToUtc(t)).filter(Boolean);
      const liveAppointmentDate = starts.length ? new Date(Math.min(...starts)) : null;
      const liveServiceNames = services.map((s) => s.service && s.service.name).filter(Boolean);
      const liveCenterName = live.center_id ? (centerName(live.center_id) || appt.centerName) : appt.centerName;

      const dateChanged = liveAppointmentDate && appt.appointmentDate && liveAppointmentDate.getTime() !== appt.appointmentDate.getTime();
      const namesChanged = liveServiceNames.length && JSON.stringify(liveServiceNames) !== JSON.stringify(appt.serviceNames);

      const livePrice = bookedPriceFromLiveAppointment(live);
      const priceChanged = livePrice != null && livePrice !== appt.bookedPrice;

      if (!dateChanged && !namesChanged && !priceChanged) continue;

      corrected++;
      log(`  ${appt.invoiceNumber || appt._id} (${appt.centerName || '—'}):`);
      if (dateChanged) log(`    appointmentDate: ${appt.appointmentDate.toISOString()} -> ${liveAppointmentDate.toISOString()}`);
      if (namesChanged) log(`    serviceNames: ${JSON.stringify(appt.serviceNames)} -> ${JSON.stringify(liveServiceNames)}`);
      if (priceChanged) log(`    bookedPrice: ${appt.bookedPrice} -> ${livePrice}`);

      if (!dryRun) {
        const update = {};
        if (dateChanged) update.appointmentDate = liveAppointmentDate;
        if (namesChanged) update.serviceNames = liveServiceNames;
        if (priceChanged) update.bookedPrice = livePrice;
        if (liveCenterName) update.centerName = liveCenterName;
        await Appointment.updateOne({ _id: appt._id }, { $set: update });
      }
    }
  }

  log(`[${brand.slug || brand._id}] checked=${checked} corrected=${corrected} cancelled=${cancelled} lookupFailed=${lookupFailed}`);
  return { checked, corrected, cancelled, lookupFailed };
}

// Runs across every brand in the db. This is what the scheduler calls.
async function syncAllBrands({ dryRun = false, log = console.log } = {}) {
  const brands = await Brand.find({});
  const totals = { checked: 0, corrected: 0, cancelled: 0, lookupFailed: 0 };
  for (const brand of brands) {
    const result = await syncBrand(brand, { dryRun, log });
    totals.checked += result.checked;
    totals.corrected += result.corrected;
    totals.cancelled += result.cancelled;
    totals.lookupFailed += result.lookupFailed;
  }
  return totals;
}

if (require.main === module) {
  const DRY_RUN = process.argv.includes('--dry-run');
  (async () => {
    await connectDB();

    const brandArg = argValue('brand');
    let totals;
    if (brandArg) {
      const brand = mongoose.isValidObjectId(brandArg)
        ? await Brand.findById(brandArg)
        : await Brand.findOne({ slug: brandArg });
      if (!brand) {
        console.error(`No brand found for "${brandArg}"`);
        process.exit(1);
      }
      totals = await syncBrand(brand, { dryRun: DRY_RUN });
    } else {
      totals = await syncAllBrands({ dryRun: DRY_RUN });
    }

    console.log(`\n--- Summary (all brands checked) ---`);
    console.log(`Appointments checked:   ${totals.checked}`);
    console.log(`Corrected:              ${totals.corrected}`);
    console.log(`Marked cancelled:       ${totals.cancelled}`);
    console.log(`Guest lookup failed:    ${totals.lookupFailed}`);
    console.log(DRY_RUN ? '\nDry run - nothing written.' : '\nWritten.');
    process.exit(0);
  })().catch((err) => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { syncBrand, syncAllBrands };