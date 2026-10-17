// scheduler.js
//
// Runs syncUpcomingAppointmentsFromZenoti.js's syncAllBrands() on a
// recurring schedule, in-process with the main server - no separate
// crontab entry to set up/maintain on the EC2 box, and it restarts
// automatically whenever the app does.
//
// Why this exists: Zenoti does not webhook an in-place edit or
// cancellation of an existing appointment (see the long comment at the
// top of syncUpcomingAppointmentsFromZenoti.js) - only creation. Without
// this running periodically, "Upcoming Bookings" silently drifts further
// from reality the longer an appointment sits un-rechecked, with nothing
// to ever correct it on its own.
//
// Every 3 hours: frequent enough that a same-day edit/cancellation gets
// caught well before the appointment time in practice, without hammering
// the Zenoti account's 50/min self-imposed quota (zenotiGuestLookup.js)
// for an account whose webhook traffic + other scripts already share it.

const cron = require('node-cron');
const { syncAllBrands } = require('../syncUpcomingAppointmentsFromZenoti');

function startScheduler() {
  cron.schedule('0 */3 * * *', async () => {
    console.log('[scheduler] Starting syncUpcomingAppointmentsFromZenoti (all brands)...');
    try {
      const totals = await syncAllBrands({ dryRun: false, log: console.log });
      console.log('[scheduler] syncUpcomingAppointmentsFromZenoti done:', totals);
    } catch (err) {
      console.error('[scheduler] syncUpcomingAppointmentsFromZenoti failed:', err.message);
    }
  });
  console.log('[scheduler] syncUpcomingAppointmentsFromZenoti scheduled every 3 hours.');
}

module.exports = { startScheduler };