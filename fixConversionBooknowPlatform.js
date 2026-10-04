// fixConversionBooknowPlatform.js
// Run this AFTER fixVisitBooknowSource.js.
//
// conversionService labels an organic conversion using the linked visit's
// utmSource at the time it processes the invoice. Before the booknow/medium
// swap fix, that meant real revenue got bucketed under a platform literally
// named "booknow" instead of "google" or "instagram" - this shows up wrong
// on every revenue-by-platform view (Overview, Reports, Campaigns).
// This corrects those existing Conversion records using each one's already-
// fixed Visit.
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');
const Visit = require('./src/db/models/Visit');

(async () => {
  await connectDB();

  const conversions = await Conversion.find({ platform: 'booknow' });
  console.log(`Found ${conversions.length} conversions labeled "booknow"...`);

  let fixed = 0;
  let skipped = 0;
  for (const conv of conversions) {
    const visit = conv.attributionVisitId ? await Visit.findById(conv.attributionVisitId) : null;
    // Fall back to "direct" (this codebase's existing convention for "no
    // usable source") rather than leaving "booknow" in place, if for some
    // reason the linked visit is gone or was never fixed.
    const realPlatform = visit && visit.utmSource && visit.utmSource !== 'booknow' ? visit.utmSource : 'direct';

    conv.platform = realPlatform;
    try {
      await conv.save();
      fixed++;
    } catch (err) {
      if (err.code === 11000) {
        // This invoice already has a separate Conversion doc for
        // `realPlatform` (rare edge case) - leave the duplicate alone
        // rather than losing revenue history; flag it for a manual look.
        console.warn(`Skipped conversion ${conv._id} (invoice ${conv.invoiceId}): a "${realPlatform}" conversion already exists for this invoice.`);
        skipped++;
      } else {
        throw err;
      }
    }
  }

  console.log(`Fixed ${fixed} of ${conversions.length} conversions. Skipped ${skipped} (need manual review, logged above).`);
  process.exit(0);
})();