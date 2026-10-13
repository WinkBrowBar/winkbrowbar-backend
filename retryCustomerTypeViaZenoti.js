// retryCustomerTypeViaZenoti.js
//
// Re-runs Zenoti verification on every invoice still tagged customerType:
// 'new' - covers both buckets backfillCustomerTypeViaZenoti.js couldn't
// confirm last time:
//   1. Customers WITH an email who hit the 429 "Account quota exceeded"
//      mid-run and never got checked.
//   2. Customers with NO email on file, who were skipped entirely before -
//      this now tries their zenotiGuestId instead, if we have one on file.
//
// Safe to re-run on invoices Zenoti already confirmed "new" too - it'll
// just confirm them again. Never touches anything already 'returning'.
//
// Much lower concurrency + a delay between every request than the first
// backfill, specifically to avoid tripping the same quota wall again. If
// several requests in a row still come back 429 even after this script's
// own per-request retries, that's very likely the WHOLE account quota
// exhausted (e.g. a daily cap, not a per-second throttle) - this stops
// early rather than burning through the rest of the list for nothing, and
// tells you how many are left so you can resume later (same command -
// already-confirmed ones are skipped automatically next time... actually
// no: a confirmed 'new' looks identical to an unconfirmed 'new' in the db,
// so re-running after a quota reset will recheck everyone currently
// tagged 'new' again. That's fine - it's a few thousand quick lookups,
// just slower than ideal).
//
// Usage:
//   node retryCustomerTypeViaZenoti.js --brand=<brandId or slug> [--delay=500] [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');
const { lookupGuestByEmail, lookupGuestById, customerTypeFromGuest } = require('./src/services/zenotiGuestLookup');

const DRY_RUN = process.argv.includes('--dry-run');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const brandArg = argValue('brand');
  if (!brandArg) {
    console.error('Usage: node retryCustomerTypeViaZenoti.js --brand=<brandId or slug> [--delay=500] [--dry-run]');
    process.exit(1);
  }
  const delayMs = Number(argValue('delay')) || 500;

  await connectDB();

  const brand = mongoose.isValidObjectId(brandArg)
    ? await Brand.findById(brandArg)
    : await Brand.findOne({ slug: brandArg });
  if (!brand) {
    console.error(`No brand found for "${brandArg}"`);
    process.exit(1);
  }

  const invoices = await Invoice.find({ brandId: brand._id, customerType: 'new' }).sort({ closedAt: 1 }).lean();
  console.log(`\n${invoices.length} invoice(s) currently tagged "new" to re-check against Zenoti (delay=${delayMs}ms between requests)...\n`);

  let confirmedNew = 0;
  let flippedToReturning = 0;
  let stillInconclusive = 0;
  let consecutive429s = 0;

  for (const [i, invoice] of invoices.entries()) {
    const customer = invoice.customerId ? await Customer.findById(invoice.customerId).lean() : null;

    let guest = null;
    if (customer && customer.email) {
      guest = await lookupGuestByEmail(customer.email);
    }
    if (!guest && customer && customer.zenotiGuestId) {
      guest = await lookupGuestById(customer.zenotiGuestId);
    }

    const zenotiType = customerTypeFromGuest(guest, invoice.closedAt);

    if (zenotiType) {
      consecutive429s = 0;
      if (zenotiType === 'returning') {
        flippedToReturning++;
        if (!DRY_RUN) await Invoice.updateOne({ _id: invoice._id }, { $set: { customerType: 'returning' } });
      } else {
        confirmedNew++;
      }
    } else {
      stillInconclusive++;
      // Heuristic: if this customer HAD an email/guestId to try and we
      // still got nothing back, assume it was a quota/rate error, not a
      // genuine "guest not found" - count it toward the abort threshold.
      if (customer && (customer.email || customer.zenotiGuestId)) consecutive429s++;
    }

    if ((i + 1) % 100 === 0) console.log(`...${i + 1}/${invoices.length} (confirmed new: ${confirmedNew}, flipped: ${flippedToReturning}, inconclusive: ${stillInconclusive})`);

    if (consecutive429s >= 10) {
      console.log(`\nStopping early - 10 lookups in a row came back inconclusive after retries. This almost certainly means the account's Zenoti API quota is exhausted again (likely a daily cap), not a one-off blip.`);
      console.log(`Processed ${i + 1}/${invoices.length}. Wait for the quota to reset (check with Zenoti support/docs for your plan's reset window) and re-run this same command - it'll pick up wherever "new" tags remain.`);
      break;
    }

    await sleep(delayMs);
  }

  console.log(`\n--- Summary ---`);
  console.log(`Confirmed genuinely new:         ${confirmedNew}`);
  console.log(`Flipped to returning:            ${flippedToReturning}`);
  console.log(`Still inconclusive (no email/id, or lookup failed): ${stillInconclusive}`);
  console.log(DRY_RUN ? '\nDry run - nothing written.' : '\nWritten.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});