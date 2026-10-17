// backfillCustomerEmailViaZenoti.js
//
// Fixes customers stuck with no email on file even though their real Zenoti
// guest profile has one. Root cause (see identityResolution.js): Zenoti's
// appointment.created/invoice.closed webhook events only carry the guest's
// id/name on the nested `guest` object, not email - only guest.created/
// guest.updated events (personal_info) reliably include it. A customer
// whose first-ever event here was a booking or invoice close, not a
// guest-created event (e.g. anyone who was already a Zenoti guest before
// this integration went live, like Lindsay Barrett), ends up with
// Customer.email permanently blank. identityResolution.js now self-heals
// this going forward on every new event; this script is the one-time catch
// up for customers already affected.
//
// Usage:
//   node backfillCustomerEmailViaZenoti.js --brand=<brandId or slug> [--concurrency=5] [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Customer = require('./src/db/models/Customer');
const { lookupGuestById, extractGuestEmail, extractGuestPhone } = require('./src/services/zenotiGuestLookup');

const DRY_RUN = process.argv.includes('--dry-run');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

async function runWithConcurrency(items, concurrency, worker) {
  let i = 0;
  let active = 0;
  return new Promise((resolve, reject) => {
    function next() {
      if (i >= items.length && active === 0) return resolve();
      while (active < concurrency && i < items.length) {
        const item = items[i++];
        active++;
        worker(item)
          .catch((err) => console.error('Worker error:', err.message))
          .finally(() => {
            active--;
            next();
          });
      }
    }
    next();
  });
}

(async () => {
  const brandArg = argValue('brand');
  if (!brandArg) {
    console.error('Usage: node backfillCustomerEmailViaZenoti.js --brand=<brandId or slug> [--concurrency=5] [--dry-run]');
    process.exit(1);
  }
  const concurrency = Number(argValue('concurrency')) || 5;

  await connectDB();

  const brand = mongoose.isValidObjectId(brandArg)
    ? await Brand.findById(brandArg)
    : await Brand.findOne({ slug: brandArg });
  if (!brand) {
    console.error(`No brand found for "${brandArg}"`);
    process.exit(1);
  }

  const customers = await Customer.find({
    brandId: brand._id,
    zenotiGuestId: { $exists: true, $ne: null },
    $or: [{ email: null }, { email: '' }, { email: { $exists: false } }],
  });

  console.log(`\n${customers.length} customer(s) with a zenotiGuestId but no email on file. Looking each up in Zenoti (concurrency=${concurrency})...\n`);

  let processed = 0;
  let emailFound = 0;
  let noEmailInZenoti = 0;
  let lookupFailed = 0;

  await runWithConcurrency(customers, concurrency, async (customer) => {
    processed++;
    try {
      const guest = await lookupGuestById(customer.zenotiGuestId);
      if (!guest) {
        lookupFailed++;
        return;
      }
      const foundEmail = extractGuestEmail(guest);
      const foundPhone = !customer.phone ? extractGuestPhone(guest) : null;
      if (!foundEmail) {
        noEmailInZenoti++;
        return;
      }
      emailFound++;
      console.log(`  ${customer.name || customer._id}: found ${foundEmail}`);
      if (!DRY_RUN) {
        const update = { email: foundEmail };
        if (foundPhone) update.phone = foundPhone;
        await Customer.updateOne({ _id: customer._id }, { $set: update });
      }
    } catch (err) {
      lookupFailed++;
      console.error(`  ${customer.name || customer._id}: lookup failed - ${err.message}`);
    }
    if (processed % 50 === 0) console.log(`...${processed}/${customers.length} processed`);
  });

  console.log(`\n--- Summary ---`);
  console.log(`Customers checked:                 ${processed}`);
  console.log(`Email found and backfilled:        ${emailFound}`);
  console.log(`Zenoti profile genuinely has none:  ${noEmailInZenoti}`);
  console.log(`Lookup failed:                      ${lookupFailed}`);
  console.log(DRY_RUN ? '\nDry run - nothing written.' : '\nWritten.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});