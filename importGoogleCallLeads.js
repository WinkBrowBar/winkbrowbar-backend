// importGoogleCallLeads.js
//
// Imports a Google Ads call-reporting export (CSV) into CallLead, so
// conversionService.js can attribute a later invoice to 'google' for a
// customer who called in rather than booked/bought through the website.
// See src/db/models/CallLead.js and src/services/callLeadMatching.js.
//
// Expected CSV: a header row, then one row per call, with (at least) these
// three columns, in any order/casing:
//   Call Date      - any parseable date, e.g. 2026-10-15
//   Phone Number    - whatever format Google Ads exports (normalized here)
//   Caller Name     - optional, kept only for reference
//
// Usage:
//   node importGoogleCallLeads.js --brand=<brandId or slug> --file=<path.csv> [--dry-run]

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const CallLead = require('./src/db/models/CallLead');
const { normalizePhone, utcMidnight } = require('./src/services/callLeadMatching');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

// Minimal CSV line split - handles plain commas and simple "quoted, values"
// (no embedded newlines/escaped quotes). Good enough for a Google Ads call
// export; swap for a real CSV lib if a sheet ever needs more than this.
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

function findColumn(headers, candidates) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const name of candidates) {
    const idx = lower.indexOf(name);
    if (idx !== -1) return idx;
  }
  return -1;
}

async function run() {
  const brandArg = argValue('brand');
  const filePath = argValue('file');
  const dryRun = process.argv.includes('--dry-run');

  if (!brandArg || !filePath) {
    console.error('Usage: node importGoogleCallLeads.js --brand=<brandId or slug> --file=<path.csv> [--dry-run]');
    process.exit(1);
  }

  await connectDB();

  const brand = mongoose.isValidObjectId(brandArg)
    ? await Brand.findById(brandArg)
    : await Brand.findOne({ slug: brandArg });
  if (!brand) {
    console.error(`No brand found for "${brandArg}"`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    console.error('File has no data rows.');
    process.exit(1);
  }

  const headers = parseCsvLine(lines[0]);
  const dateCol = findColumn(headers, ['call date', 'date']);
  const phoneCol = findColumn(headers, ['phone number', 'phone', 'caller number']);
  const nameCol = findColumn(headers, ['caller name', 'name']);

  if (dateCol === -1 || phoneCol === -1) {
    console.error(`Could not find required columns in header: ${headers.join(', ')}`);
    console.error('Need at least a "Call Date" and "Phone Number" column.');
    process.exit(1);
  }

  let imported = 0;
  let skippedBadPhone = 0;
  let skippedBadDate = 0;
  let duplicates = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const rawPhone = cells[phoneCol];
    const rawDate = cells[dateCol];
    const callerName = nameCol !== -1 ? cells[nameCol] : null;

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      skippedBadPhone++;
      console.log(`  row ${i + 1}: couldn't parse a phone number from "${rawPhone}" - skipping`);
      continue;
    }

    const parsedDate = new Date(rawDate);
    if (Number.isNaN(parsedDate.getTime())) {
      skippedBadDate++;
      console.log(`  row ${i + 1}: couldn't parse a date from "${rawDate}" - skipping`);
      continue;
    }
    const callDate = utcMidnight(parsedDate);

    if (dryRun) {
      console.log(`  row ${i + 1}: would import phone=${phone} callDate=${callDate.toISOString().slice(0, 10)} name=${callerName || '—'}`);
      imported++;
      continue;
    }

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
      if (err.code === 11000) {
        duplicates++;
      } else {
        throw err;
      }
    }
  }

  console.log(`\n--- Summary (${brand.slug || brand._id}) ---`);
  console.log(`Imported:            ${imported}`);
  console.log(`Duplicates skipped:  ${duplicates}`);
  console.log(`Bad phone skipped:   ${skippedBadPhone}`);
  console.log(`Bad date skipped:    ${skippedBadDate}`);
  console.log(dryRun ? '\nDry run - nothing written.' : '\nWritten.');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});