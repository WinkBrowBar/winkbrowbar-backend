// syncCallLeadsFromSheet.js
//
// Pulls a brand's public Google Ads call-log sheet (Brand.callLeadSheetUrl)
// and imports any new rows into CallLead - the "panel" alternative to
// running importGoogleCallLeads.js by hand. Called on demand from
// dashboardRoutes.js (sync-now button) and periodically from scheduler.js.
//
// The sheet must be shared "Anyone with the link can view" (File > Share) -
// this reads it unauthenticated via Google's own CSV export endpoint, the
// same way any public viewer would.

const axios = require('axios');
const CallLead = require('../db/models/CallLead');
const { parseCsv, findColumn } = require('../utils/csv');
const { normalizePhone, utcMidnight } = require('./callLeadMatching');

// Accepts whatever link a person actually copies out of Google Sheets -
// normally https://docs.google.com/spreadsheets/d/<ID>/edit#gid=<GID> - and
// turns it into the CSV export endpoint. Also accepts an export URL already
// pasted in, unchanged.
function toCsvExportUrl(sheetUrl) {
  if (!sheetUrl) return null;
  if (/\/export\?/.test(sheetUrl) && /format=csv/.test(sheetUrl)) return sheetUrl;

  const idMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) return null;
  const sheetId = idMatch[1];

  const gidMatch = sheetUrl.match(/[#&?]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : '0';

  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

// Returns a summary: { imported, duplicates, skippedBadPhone, skippedBadDate, error }
async function syncCallLeadsFromSheet(brand) {
  const exportUrl = toCsvExportUrl(brand.callLeadSheetUrl);
  if (!exportUrl) {
    return { error: 'No valid Google Sheet link saved for this brand (or the link format wasn\'t recognized).' };
  }

  let csvText;
  try {
    const { data } = await axios.get(exportUrl, { timeout: 15000, responseType: 'text' });
    csvText = data;
  } catch (err) {
    // Most common cause: the sheet isn't shared "Anyone with the link can
    // view" yet, so Google redirects to a login page instead of CSV.
    return { error: `Could not fetch the sheet (${err.response ? err.response.status : err.message}). Make sure it's shared "Anyone with the link can view".` };
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return { error: 'Sheet has no data rows.' };
  }

  const headers = rows[0];
  const dateCol = findColumn(headers, ['call date', 'date']);
  const phoneCol = findColumn(headers, ['phone number', 'phone', 'caller number']);
  const nameCol = findColumn(headers, ['caller name', 'name']);

  if (dateCol === -1 || phoneCol === -1) {
    return { error: `Couldn't find "Call Date"/"Phone Number" columns in the sheet header: ${headers.join(', ')}` };
  }

  let imported = 0;
  let duplicates = 0;
  let skippedBadPhone = 0;
  let skippedBadDate = 0;

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const rawPhone = cells[phoneCol];
    const rawDate = cells[dateCol];
    const callerName = nameCol !== -1 ? cells[nameCol] : null;

    const phone = normalizePhone(rawPhone);
    if (!phone) { skippedBadPhone++; continue; }

    const parsedDate = new Date(rawDate);
    if (Number.isNaN(parsedDate.getTime())) { skippedBadDate++; continue; }
    const callDate = utcMidnight(parsedDate);

    try {
      await CallLead.create({
        brandId: brand._id,
        phone,
        rawPhone,
        callerName: callerName || null,
        callDate,
      });
      imported++;
    } catch (err) {
      if (err.code === 11000) duplicates++;
      else throw err;
    }
  }

  return { imported, duplicates, skippedBadPhone, skippedBadDate };
}

module.exports = { syncCallLeadsFromSheet, toCsvExportUrl };