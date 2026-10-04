/**
 * Quick helper: lists every Brand in the DB with the exact values you need
 * for backfillMissedZenotiInvoices.js (brandId, slug, zenotiCenterId).
 *
 * Usage:
 *   node listBrands.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');

async function run() {
  await connectDB();

  const brands = await Brand.find({}).lean();

  if (brands.length === 0) {
    console.log('No brands found in this database.');
  }

  brands.forEach((b) => {
    console.log('---');
    console.log(`name:            ${b.name}`);
    console.log(`_id (brandId):   ${b._id}`);
    console.log(`slug:            ${b.slug}`);
    console.log(`zenotiCenterId:  ${b.zenotiCenterId || '(not set)'}`);
    console.log(`isActive:        ${b.isActive}`);
  });

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Failed to list brands:', err);
  process.exit(1);
});