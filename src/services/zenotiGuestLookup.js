// zenotiGuestLookup.js
//
// Confirmed working 2026-10-13 against the real account (checkZenotiGuestLookup.js):
// GET /v1/guests/search?email=... - no center_id needed, single lightweight
// call. Returns the guest's own Zenoti profile, including created_date -
// when THAT guest record was first created in Zenoti, which reflects their
// real history on Zenoti's side, not just however far back our own
// tracking happens to go.
//
// This is the live, per-transaction check: send the customer's email to
// Zenoti, get back when their guest profile was created, compare that to
// this invoice's close time.

const axios = require('axios');

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Confirmed against Zenoti's own docs (docs.zenoti.com/docs/api-rate-limits-1):
// this account's cap is a sliding 60-calls-PER-MINUTE window that
// continuously refills, not a daily cap. The retry-with-backoff below reacts
// AFTER a 429 already happened; it doesn't stop one from happening in the
// first place. A backfill script firing several lookups concurrently blows
// through the 60/min budget in the first second or two (confirmed live:
// backfillCustomerEmailViaZenoti.js at concurrency=5 started drawing 429s
// within the first ~100 customers), so every call in this file is paced
// through one shared sliding-window gate first - self-throttling to stay
// under quota instead of bursting and hoping the retry catches it. 50/min
// (not 60) leaves headroom for whatever else is also hitting this account's
// key at the same time (live webhook traffic, other scripts).
const MAX_CALLS_PER_MINUTE = 50;
const callTimestamps = [];
async function throttle() {
  const now = Date.now();
  while (callTimestamps.length && now - callTimestamps[0] > 60000) callTimestamps.shift();
  if (callTimestamps.length >= MAX_CALLS_PER_MINUTE) {
    const waitMs = 60000 - (now - callTimestamps[0]) + 50;
    await sleep(waitMs);
    return throttle();
  }
  callTimestamps.push(Date.now());
}

// Retries a 429 ("Account quota exceeded") a few times with backoff, on top
// of the self-throttle above - a safety net for the rare case another
// process sharing this API key (live webhooks, a different script) used up
// quota this instance didn't know about.
async function getWithRetry(url, config, { retries = 3, baseDelayMs = 2000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle();
    try {
      return await axios.get(url, config);
    } catch (err) {
      const is429 = err.response && err.response.status === 429;
      if (!is429 || attempt === retries) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

async function lookupGuestByEmail(email) {
  if (!email || !ZENOTI_API_KEY) return null;
  try {
    const { data } = await getWithRetry(`${ZENOTI_API_BASE}/v1/guests/search`, {
      params: { email },
      headers: { Authorization: `apikey ${ZENOTI_API_KEY}` },
      timeout: 8000,
    });
    const guests = data.guests || [];
    return guests[0] || null;
  } catch (err) {
    // Never let a Zenoti hiccup break invoice processing - caller falls
    // back to the db-based guess when this returns null.
    console.error(`zenotiGuestLookup (email) failed for ${email}:`, err.response ? JSON.stringify(err.response.data) : err.message);
    return null;
  }
}

// For a customer with no email on file but a known zenotiGuestId (captured
// from an earlier webhook) - looks the guest up directly by id instead.
// Not yet confirmed authorized for this account's key the way the email
// search endpoint is - falls back the same way if it 403s.
async function lookupGuestById(guestId) {
  if (!guestId || !ZENOTI_API_KEY) return null;
  try {
    const { data } = await getWithRetry(`${ZENOTI_API_BASE}/v1/guests/${guestId}`, {
      headers: { Authorization: `apikey ${ZENOTI_API_KEY}` },
      timeout: 8000,
    });
    return data || null;
  } catch (err) {
    console.error(`zenotiGuestLookup (id) failed for ${guestId}:`, err.response ? JSON.stringify(err.response.data) : err.message);
    return null;
  }
}

// Confirmed working 2026-10-13 (checkZenotiGuestHistory.js, investigating a
// real mislabel on Cynthia Johnson / invoice WV25491): GET
// /v1/guests/{id}/appointments returns the guest's REAL appointment/invoice
// history - the same data Zenoti's own "Past Treatments" tab shows. This is
// stronger ground truth than guest.created_date (a single profile-creation
// timestamp) - it's an actual list of past visits, so "does an earlier one
// exist" is a direct fact, not an inference. Used as the primary signal;
// created_date is now only the fallback if this endpoint itself fails.
async function lookupGuestAppointments(guestId) {
  if (!guestId || !ZENOTI_API_KEY) return null;
  try {
    const { data } = await getWithRetry(`${ZENOTI_API_BASE}/v1/guests/${guestId}/appointments`, {
      headers: { Authorization: `apikey ${ZENOTI_API_KEY}` },
      timeout: 10000,
    });
    return data && Array.isArray(data.appointments) ? data.appointments : null;
  } catch (err) {
    console.error(`zenotiGuestLookup (appointments) failed for ${guestId}:`, err.response ? JSON.stringify(err.response.data) : err.message);
    return null;
  }
}

function earliestServiceStart(appointment) {
  const services = Array.isArray(appointment.appointment_services) ? appointment.appointment_services : [];
  const times = services.map((s) => s.start_time).filter(Boolean).map((t) => new Date(t)).filter((d) => !Number.isNaN(d.getTime()));
  return times.length ? new Date(Math.min(...times)) : null;
}

// Returns 'new' | 'returning' | null (null = this endpoint gave nothing
// usable - caller falls back to customerTypeFromGuest/created_date).
// 'returning' the moment ANY other appointment on this guest's real history
// has a service start time strictly before `beforeDate` - excluding the
// appointment group this exact transaction came from, so a booking doesn't
// count itself as its own "earlier" visit.
function customerTypeFromAppointmentHistory(appointments, { beforeDate, excludeAppointmentGroupId } = {}) {
  if (!Array.isArray(appointments)) return null;
  const before = new Date(beforeDate);
  if (Number.isNaN(before.getTime())) return null;
  const hasEarlierVisit = appointments.some((appt) => {
    if (excludeAppointmentGroupId && appt.appointment_group_id === excludeAppointmentGroupId) return false;
    const start = earliestServiceStart(appt);
    return start && start < before;
  });
  return hasEarlierVisit ? 'returning' : 'new';
}

// How long after the guest profile was created do we still call this
// purchase "new"? Not same-day-only, because a guest profile is often
// created at BOOKING time, a few days before the actual visit/invoice
// close - 72h covers that normal gap without stretching so far it starts
// calling a real returning customer "new". Only used as a fallback now -
// see customerTypeFromAppointmentHistory above for the primary check.
const NEW_GUEST_WINDOW_HOURS = 72;

function customerTypeFromGuest(guest, invoiceClosedAt) {
  if (!guest || !guest.created_date) return null;
  const createdAt = new Date(guest.created_date);
  const closedAt = new Date(invoiceClosedAt);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(closedAt.getTime())) return null;
  const hoursBetween = (closedAt - createdAt) / (1000 * 60 * 60);
  // Negative means the guest profile was created AFTER this invoice closed
  // - shouldn't normally happen (the invoice is tied to this exact guest),
  // but if clocks/ordering are off, don't guess - let the db fallback decide.
  if (hoursBetween < 0) return null;
  return hoursBetween <= NEW_GUEST_WINDOW_HOURS ? 'new' : 'returning';
}

// Single entry point every call site should use. Tries, in order:
//   1. Real appointment history (ground truth, same as "Past Treatments")
//   2. Guest profile created_date (fallback if #1 fails)
//   3. null (caller falls back to its own db-only guess)
// One email/id lookup + one appointment-history lookup per call - same
// quota cost as before, just a more reliable answer.
async function determineCustomerType({ email, zenotiGuestId, atDate, excludeAppointmentGroupId }) {
  let guest = await lookupGuestByEmail(email);
  if (!guest && zenotiGuestId) {
    guest = await lookupGuestById(zenotiGuestId);
  }
  const guestId = (guest && guest.id) || zenotiGuestId;
  if (!guestId) return null;

  const appointments = await lookupGuestAppointments(guestId);
  const fromHistory = customerTypeFromAppointmentHistory(appointments, { beforeDate: atDate, excludeAppointmentGroupId });
  if (fromHistory) return fromHistory;

  return customerTypeFromGuest(guest, atDate);
}

// Zenoti's own REST responses (GET /v1/guests/{id} and /v1/guests/search)
// haven't been confirmed field-by-field against a real payload yet - unlike
// the webhook event shape (data.personal_info.email), which IS confirmed
// (see zenotiWebhook.js). Check every shape that's been seen in Zenoti's
// docs/other integrations rather than assuming one, so a guest's email gets
// picked up regardless of which shape this account's API actually returns.
function extractGuestEmail(guest) {
  if (!guest) return null;
  return (
    guest.email
    || guest.email_id
    || (guest.personal_info && (guest.personal_info.email || guest.personal_info.email_id))
    || null
  );
}

function extractGuestPhone(guest) {
  if (!guest) return null;
  const mobile = guest.mobile_phone || (guest.personal_info && guest.personal_info.mobile_phone);
  if (mobile && mobile.number) {
    return mobile.phone_code ? `+${mobile.phone_code} ${mobile.number}` : mobile.number;
  }
  return guest.phone || null;
}

module.exports = {
  lookupGuestByEmail,
  lookupGuestById,
  lookupGuestAppointments,
  customerTypeFromAppointmentHistory,
  customerTypeFromGuest,
  determineCustomerType,
  extractGuestEmail,
  extractGuestPhone,
  NEW_GUEST_WINDOW_HOURS,
};