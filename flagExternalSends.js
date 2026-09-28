// flagExternalSends.js
//
// After the 2026-09-28 decision to stop sending customer data to Google/Meta
// externally, conversionService.js now records "sent" for these platforms
// without ever calling their API (see NO_EXTERNAL_SEND_PLATFORMS). This
// script does NOT touch Google/Meta or change any counts/status - it only
// adds a marker field inside the existing platformResponse on OLD records,
// so it's clear in our own database which ones genuinely had customer data
// leave the system (before the policy changed) vs which ones after this
// point are internal-tracking-only.
//
// Read-only by default. Add --apply to actually write the flag.
//
// Usage:
//   node flagExternalSends.js            # preview only, writes nothing
//   node flagExternalSends.js --apply    # actually flags the records

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');

const APPLY = process.argv.includes('--apply');

(async () => {
  await connectDB();

  // Real external sends only - excludes anything already carrying the new
  // internal-only marker (so this is safe to re-run without re-flagging).
  const candidates = await Conversion.find({
    platform: { $in: ['google', 'meta'] },
    status: 'sent',
    'platformResponse.note': { $ne: 'Internal attribution only - no data sent to the external platform (decision 2026-09-28)' },
  });

  console.log(`Found ${candidates.length} record(s) where real customer data was actually sent to Google/Meta before the policy change.\n`);

  for (const c of candidates.slice(0, 20)) {
    console.log(`  ${c.platform} | invoiceId ${c.invoiceId} | sentAt ${c.sentAt ? c.sentAt.toISOString() : '(none)'}`);
  }
  if (candidates.length > 20) console.log(`  ...and ${candidates.length - 20} more`);

  if (!APPLY) {
    console.log('\nDRY RUN - nothing written. Re-run with --apply to actually flag these records.');
    process.exit(0);
  }

  let flagged = 0;
  for (const c of candidates) {
    c.platformResponse = {
      ...(c.platformResponse || {}),
      dataSentExternallyBeforePolicyChange: true,
      flaggedAt: new Date(),
    };
    await c.save();
    flagged += 1;
  }

  console.log(`\nFlagged ${flagged} record(s). Status/counts unchanged - dashboard numbers stay exactly the same.`);
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});