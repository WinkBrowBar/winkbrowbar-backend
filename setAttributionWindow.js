// setAttributionWindow.js
//
// Updates Brand.attributionWindowDays - how many days a tracked ad click
// (gclid/fbclid/awinClickId) stays eligible to get credit for a later
// purchase. Already fully wired up in src/services/attribution.js
// (pickAttributedVisit reads this per-brand) - this just changes the
// number, no code/deploy needed.
//
// Usage:
//   node setAttributionWindow.js --brand=<brandId or slug> --days=7

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  const brandArg = argValue('brand');
  const days = Number(argValue('days'));
  if (!brandArg || !days) {
    console.error('Usage: node setAttributionWindow.js --brand=<brandId or slug> --days=7');
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

  console.log(`${brand.name}: attributionWindowDays ${brand.attributionWindowDays} -> ${days}`);
  brand.attributionWindowDays = days;
  await brand.save();
  console.log('Saved.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});