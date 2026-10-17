// diagnoseMissingEmail.js
//
// For a handful of named customers who still show no email after
// backfillCustomerEmailViaZenoti.js, prints:
//   - the Customer doc (email/phone/zenotiGuestId) as it stands in our db
//   - the RAW Zenoti guest payload for that zenotiGuestId (if present)
// so we can see whether Zenoti genuinely has no email on file, or whether
// it's sitting in a field shape extractGuestEmail() doesn't check yet.
//
// Usage:
//   node diagnoseMissingEmail.js --brand=<brandId or slug> --names="Pauline Mottet,Nhnaher Barbone,Niki Mira"

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Customer = require('./src/db/models/Customer');

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  const brandArg = argValue('brand');
  const namesArg = argValue('names');
  if (!brandArg || !namesArg) {
    console.error('Usage: node diagnoseMissingEmail.js --brand=<brandId or slug> --names="Name One,Name Two"');
    process.exit(1);
  }
  const names = namesArg.split(',').map((n) => n.trim()).filter(Boolean);

  await connectDB();

  const brand = mongoose.isValidObjectId(brandArg)
    ? await Brand.findById(brandArg)
    : await Brand.findOne({ slug: brandArg });
  if (!brand) {
    console.error(`No brand found for "${brandArg}"`);
    process.exit(1);
  }

  for (const name of names) {
    console.log(`\n=== ${name} ===`);
    const customers = await Customer.find({
      brandId: brand._id,
      name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
    });

    if (!customers.length) {
      console.log('  No Customer doc found with this exact name (could be a name variant/typo).');
      continue;
    }

    for (const c of customers) {
      console.log(`  Customer _id=${c._id}`);
      console.log(`    email: ${c.email || '(none)'}`);
      console.log(`    phone: ${c.phone || '(none)'}`);
      console.log(`    zenotiGuestId: ${c.zenotiGuestId || '(none)'}`);

      if (!c.zenotiGuestId) {
        console.log('    -> No zenotiGuestId at all. This customer was never in scope for the id-based backfill.');
        continue;
      }
      if (!ZENOTI_API_KEY) {
        console.log('    -> ZENOTI_API_KEY not set, skipping live lookup.');
        continue;
      }
      try {
        const { data: guest } = await axios.get(`${ZENOTI_API_BASE}/v1/guests/${c.zenotiGuestId}`, {
          headers: { Authorization: `apikey ${ZENOTI_API_KEY}` },
          timeout: 8000,
        });
        console.log('    Raw Zenoti guest payload:');
        console.log(JSON.stringify(guest, null, 2).split('\n').map((l) => `      ${l}`).join('\n'));
      } catch (err) {
        console.log(`    -> Live Zenoti lookup failed: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
      }
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});