// centerTimezone.js
//
// Zenoti sends appointment times two ways: a plain UTC-ish field and an
// "_in_center" field with no timezone offset in the string at all (e.g.
// "2026-09-29T12:00:00") - that second one is wall-clock local time at the
// center, not UTC. All three of our centers (Cobble Hill, West Village,
// Upper East Side) are in NYC, so "America/New_York" covers all of them.
//
// Passing a naive string straight to `new Date(...)` makes Node treat it as
// UTC (on a UTC-TZ server, which EC2 is), silently storing the wrong
// instant - off by the Eastern/UTC offset (4-5h depending on DST). This
// converts it correctly, DST-aware, with no extra dependency (uses the
// built-in Intl API).

const CENTER_TIME_ZONE = 'America/New_York';

function getTimeZoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  const match = tzPart && tzPart.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const mins = Number(match[3] || 0);
  return sign * (hours * 60 + mins);
}

// naiveDateString: e.g. "2026-09-29T12:00:00" - wall-clock time IN the
// center's own timezone, no offset in the string. Returns the correct UTC
// Date instant, or null if the input is missing/unparseable.
function centerLocalTimeToUtc(naiveDateString) {
  if (!naiveDateString) return null;
  const guessUtc = new Date(`${naiveDateString}Z`);
  if (Number.isNaN(guessUtc.getTime())) return null;
  const offsetMinutes = getTimeZoneOffsetMinutes(guessUtc, CENTER_TIME_ZONE);
  return new Date(guessUtc.getTime() - offsetMinutes * 60 * 1000);
}

module.exports = { centerLocalTimeToUtc, CENTER_TIME_ZONE };