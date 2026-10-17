// Minimal CSV parsing shared by importGoogleCallLeads.js (CLI) and
// syncCallLeadsFromSheet.js (public Google Sheet pull). Handles plain
// commas and simple "quoted, values" - no embedded newlines/escaped quotes.
// Good enough for a Google Ads call export; swap for a real CSV lib if a
// sheet ever needs more than this.
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function parseCsv(text) {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0).map(parseCsvLine);
}

function findColumn(headers, candidates) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const name of candidates) {
    const idx = lower.indexOf(name);
    if (idx !== -1) return idx;
  }
  return -1;
}

module.exports = { parseCsvLine, parseCsv, findColumn };