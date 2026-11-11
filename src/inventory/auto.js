// auto.js - automatic Zenoti -> Shopify studio stock sync (same rules as the dashboard's Apply button).
// Zenoti has no "stock changed" webhook, so a sync runs:
//   - 2 min after an invoice closes at a Wink studio (in-store sale or return). A burst of sales = one run.
//   - every 30 min from scheduler.js, to catch transfers, receiving and manual adjustments in Zenoti.
// Never forced: if a run would drop too many items to 0 it shows as "Blocked" in the Logs tab and
// nothing is written. Runs with nothing to change are not logged. Turn off with INVENTORY_AUTO_SYNC=off.
const config = require('./config.json');
const engine = require('./engine');

const DEBOUNCE_MS = 2 * 60 * 1000;
const studioCenters = new Set(Object.values(config.centers));
let timer = null;
let running = false;
let pending = null;

const enabled = () => String(process.env.INVENTORY_AUTO_SYNC || 'on').toLowerCase() !== 'off';

function schedule(reason) {
  if (!enabled()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; run(reason); }, DEBOUNCE_MS);
  if (timer.unref) timer.unref(); // never keeps a one-off script alive
}

// Called from the Zenoti invoice webhook. Ignores centers that aren't a synced studio.
function onInvoiceClosed(centerId) {
  if (centerId && !studioCenters.has(String(centerId))) return;
  schedule('after sale');
}

async function run(reason = 'scheduled') {
  if (!enabled()) return;
  if (running) { pending = reason; return; }
  running = true;
  try {
    const r = await engine.applyPlan({ who: `auto (${reason})` });
    if (r.written || r.failed) console.log(`[inventory-auto] ${reason}: ${r.written} written, ${r.failed} failed`);
  } catch (e) {
    if (e.status === 409) pending = reason; // a manual Apply is running - try again after it
    else if (e.status !== 400) { // 400 = blocked by safety limits (already logged) or no links saved yet
      console.error('[inventory-auto] failed:', e.message);
      await engine.logActivity({ type: 'error', who: 'auto', summary: `Auto sync failed: ${e.message}` });
    }
  } finally {
    running = false;
    if (pending) { const p = pending; pending = null; schedule(p); }
  }
}

module.exports = { onInvoiceClosed, run };