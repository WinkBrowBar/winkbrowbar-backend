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

// Retries a 429 ("Account quota exceeded") a few times with backoff - a
// single transient throttle, not the whole quota, usually clears within a
// few seconds. If it's still 429 after all retries, this almost certainly
// IS the whole account quota exhausted (e.g. a daily cap) - no amount of
// retrying from here will fix that; the caller gets null and falls back,
// same as any other failure.
async function getWithRetry(url, config, { retries = 3, baseDelayMs = 2000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
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

// How long after the guest profile was created do we still call this
// purchase "new"? Not same-day-only, because a guest profile is often
// created at BOOKING time, a few days before the actual visit/invoice
// close - 72h covers that normal gap without stretching so far it starts
// calling a real returning customer "new".
const NEW_GUEST_WINDOW_HOURS = 72;

// Returns 'new' | 'returning' | null (null = couldn't determine from
// Zenoti - caller should fall back to the db-based guess).
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

module.exports = { lookupGuestByEmail, lookupGuestById, customerTypeFromGuest, NEW_GUEST_WINDOW_HOURS };