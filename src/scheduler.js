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
const Brand = require('./db/models/Brand');
const { syncCallLeadsFromSheet } = require('./services/syncCallLeadsFromSheet');

// Pulls every brand's Google Ads call-log sheet (whichever ones actually
// have one saved - see dashboardRoutes.js's call-lead-sheet panel) so new
// call rows show up without anyone having to click "Sync now" or run
// importGoogleCallLeads.js by hand. Hourly is plenty - call leads only need
// to exist in CallLead by the time the matching invoice closes, which is
// never that fast after a call.
async function syncCallLeadSheets() {
  const brands = await Brand.find({ callLeadSheetUrl: { $nin: [null, ''] } });
  for (const brand of brands) {
    try {
      const result = await syncCallLeadsFromSheet(brand);
      brand.lastCallLeadSyncAt = new Date();
      brand.lastCallLeadSyncResult = result;
      await brand.save();
      if (result.error) {
        console.error(`[scheduler] call-lead sheet sync failed for ${brand.slug || brand._id}:`, result.error);
      } else {
        console.log(`[scheduler] call-lead sheet synced for ${brand.slug || brand._id}:`, result);
      }
    } catch (err) {
      console.error(`[scheduler] call-lead sheet sync threw for ${brand.slug || brand._id}:`, err.message);
    }
  }
}

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

  cron.schedule('0 * * * *', async () => {
    console.log('[scheduler] Starting call-lead sheet sync (all brands)...');
    await syncCallLeadSheets();
  });
  console.log('[scheduler] Call-lead sheet sync scheduled every hour.');
}

module.exports = { startScheduler };