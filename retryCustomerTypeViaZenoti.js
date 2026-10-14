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
// Updated 2026-10-14: now uses determineCustomerType, which checks the
// guest's REAL appointment/invoice history first (GET
// /v1/guests/{id}/appointments - same data as Zenoti's "Past Treatments"
// tab), falling back to guest profile created_date only if that fails.
// Found via a real mislabel (Cynthia Johnson / invoice WV25491, tagged
// "new" despite a March 2024 purchase) that turned out to be a quota
// failure that day, not a bad signal - but the appointment-history check is
// strictly more reliable than a single created_date field, so it's now the
// primary check everywhere.
//
// Updated 2026-10-14 again: confirmed against Zenoti's own docs
// (docs.zenoti.com/docs/api-rate-limits-1) that "Account quota exceeded" is
// NOT a daily cap - it's a sliding 60-calls-PER-MINUTE limit that
// continuously refills. Earlier runs kept tripping it because
// determineCustomerType can make up to 2 Zenoti calls per customer (guest
// lookup + appointment history), and a 500ms delay between customers works
// out to ~120 calls/min - double the real limit.
//
// Fixed two ways: the default delay is now paced to stay under 60/min even
// in the 2-call-per-customer worst case, AND hitting 429 repeatedly no
// longer aborts the whole run - it just waits out one refill window
// (COOLDOWN_MS) and keeps going, since the limit resets within a minute,
// not a day.
//
// Usage:
//   node retryCustomerTypeViaZenoti.js --brand=<brandId or slug> [--delay=2200] [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');
const { determineCustomerType } = require('./src/services/zenotiGuestLookup');

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
    console.error('Usage: node retryCustomerTypeViaZenoti.js --brand=<brandId or slug> [--delay=2200] [--dry-run]');
    process.exit(1);
  }
  // 2200ms default: worst case 2 Zenoti calls/customer -> ~55 calls/min,
  // safely under the real 60/min limit with some headroom.
  const delayMs = Number(argValue('delay')) || 2200;
  const COOLDOWN_MS = 65000; // one full refill window, plus a little buffer

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

    const zenotiType = customer
      ? await determineCustomerType({ email: customer.email, zenotiGuestId: customer.zenotiGuestId, atDate: invoice.closedAt })
      : null;

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
      // Confirmed via Zenoti's docs: this is a 60/min sliding limit, not a
      // daily cap - wait out one refill window instead of giving up.
      console.log(`\n10 lookups in a row came back inconclusive - likely the 60/min rate limit. Cooling down ${COOLDOWN_MS / 1000}s before continuing (processed ${i + 1}/${invoices.length} so far)...`);
      await sleep(COOLDOWN_MS);
      consecutive429s = 0;
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