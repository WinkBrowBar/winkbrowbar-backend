const CallLead = require('../db/models/CallLead');

// Last 10 digits only - absorbs +1/1/country-code and formatting
// differences between Google Ads' export and however Customer.phone or
// Zenoti happened to store the number (see extractGuestPhone in
// zenotiGuestLookup.js for the kind of variation already seen there).
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function utcMidnight(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Finds a call-log row for this phone whose reported call date is within
// +-1 day of `aroundDate` (the invoice's close date) - a call date doesn't
// have to land on the exact same calendar day as the purchase (decision
// 2026-10-17: Google Ads' reported call date and the eventual invoice close
// date can be a day apart either way).
async function findMatchingCallLead({ brandId, phone, aroundDate }) {
  const normalized = normalizePhone(phone);
  if (!normalized || !aroundDate) return null;

  const center = utcMidnight(aroundDate);
  const dayMs = 24 * 60 * 60 * 1000;
  const windowStart = new Date(center.getTime() - dayMs);
  const windowEnd = new Date(center.getTime() + dayMs);

  return CallLead.findOne({
    brandId,
    phone: normalized,
    callDate: { $gte: windowStart, $lte: windowEnd },
  }).sort({ callDate: 1 });
}

module.exports = { normalizePhone, utcMidnight, findMatchingCallLead };