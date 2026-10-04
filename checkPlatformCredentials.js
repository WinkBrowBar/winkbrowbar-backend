/**
 * Read-only check: lists which platforms have active credentials configured
 * for each brand. Masks secret values so it's safe to run/share output.
 *
 * Usage: node checkPlatformCredentials.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const MarketingPlatform = require('./src/db/models/MarketingPlatform');

function mask(value) {
  if (!value) return '(missing)';
  const str = String(value);
  if (str.length <= 8) return '****';
  return str.slice(0, 4) + '...' + str.slice(-4);
}

async function run() {
  await connectDB();

  const brands = await Brand.find();
  for (const brand of brands) {
    console.log(`\nBrand: ${brand.name} (${brand._id})`);
    const platforms = await MarketingPlatform.find({ brandId: brand._id });
    if (platforms.length === 0) {
      console.log('  No platform credentials configured at all.');
      continue;
    }
    for (const p of platforms) {
      const credFields = Object.keys(p.credentials || {})
        .map((k) => `${k}=${mask(p.credentials[k])}`)
        .join(', ');
      console.log(`  ${p.platform}: active=${p.isActive} | ${credFields || '(no credential fields set)'}`);
    }
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Check failed:', err);
  process.exit(1);
});