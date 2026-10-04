// fixVisitBooknowSource.js
// One-time correction for Visit docs created before the booknow/utm_medium
// swap fix: Zenoti's own booking widget always tags utm_source="booknow",
// with the REAL source (e.g. "google", "instagram") sitting in utm_medium
// instead. Older Visit docs still have this backwards - fix them in place.
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Visit = require('./src/db/models/Visit');

(async () => {
  await connectDB();

  const visits = await Visit.find({ utmSource: 'booknow' });
  console.log(`Found ${visits.length} visits with utmSource "booknow"...`);

  let fixed = 0;
  for (const visit of visits) {
    const realSource = visit.utmMedium || 'booknow'; // keep as-is if medium is somehow also missing
    visit.utmSource = realSource;
    visit.utmMedium = null;
    await visit.save();
    fixed++;
  }

  console.log(`Fixed ${fixed} of ${visits.length} visits.`);
  process.exit(0);
})();