// backfillCustomerTypeViaZenoti.js
//
// Supersedes backfillCustomerType.js and reconcileCustomerTypeViaZenoti.js
// - those were built around the heavy Sales Accrual Report (the only
// endpoint we'd confirmed worked at the time). Confirmed 2026-10-13 that
// GET /v1/guests/search?email=... also works on this account - a single
// lightweight per-guest call - so this does the real thing directly: one
// Zenoti lookup per CUSTOMER (not per invoice), comparing their guest
// profile's created_date to their earliest closed invoice here.
//
// Only a customer's EARLIEST closed invoice can ever be "new" by
// definition - every later invoice for that same customer is "returning"
// automatically, no Zenoti call needed for those.
//
// Only touches invoices where customerType is still null - never
// overwrites one the live webhook (conversionService.js) already set.
//
// Rate-limited to a small number of concurrent requests so this doesn't
// hammer Zenoti's API across thousands of customers in one run.
//
// Usage:
//   node backfillCustomerTypeViaZenoti.js --brand=<brandId or slug> [--concurrency=5] [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');
const { lookupGuestByEmail, customerTypeFromGuest } = require('./src/services/zenotiGuestLookup');

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
    console.error('Usage: node backfillCustomerTypeViaZenoti.js --brand=<brandId or slug> [--concurrency=5] [--dry-run]');
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

  // Every closed, untagged invoice, oldest first, grouped by customer.
  const invoices = await Invoice.find({
    brandId: brand._id,
    status: 'closed',
    customerId: { $ne: null },
    customerType: null,
  }).sort({ closedAt: 1 }).lean();

  const invoicesByCustomer = new Map();
  for (const inv of invoices) {
    const key = String(inv.customerId);
    if (!invoicesByCustomer.has(key)) invoicesByCustomer.set(key, []);
    invoicesByCustomer.get(key).push(inv);
  }

  console.log(`\n${invoices.length} untagged invoice(s) across ${invoicesByCustomer.size} customer(s). Looking up each customer in Zenoti (concurrency=${concurrency})...\n`);

  let processed = 0;
  let newConfirmed = 0;
  let newFellBackToDb = 0;
  let returningTagged = 0;
  let noEmail = 0;

  await runWithConcurrency([...invoicesByCustomer.entries()], concurrency, async ([customerId, customerInvoices]) => {
    const customer = await Customer.findById(customerId).lean();
    const earliest = customerInvoices[0]; // already sorted ascending
    const laterInvoices = customerInvoices.slice(1);

    let earliestType;
    if (!customer || !customer.email) {
      noEmail++;
      earliestType = 'new'; // same assumption the old db-only guess made
    } else {
      const guest = await lookupGuestByEmail(customer.email);
      const zenotiType = customerTypeFromGuest(guest, earliest.closedAt);
      if (zenotiType) {
        earliestType = zenotiType;
        if (zenotiType === 'new') newConfirmed++; else returningTagged++;
      } else {
        earliestType = 'new'; // db-only fallback - this WAS their first invoice we know of
        newFellBackToDb++;
      }
    }

    processed++;
    if (processed % 200 === 0) console.log(`...${processed}/${invoicesByCustomer.size} customers processed`);

    if (!DRY_RUN) {
      await Invoice.updateOne({ _id: earliest._id }, { $set: { customerType: earliestType } });
      if (laterInvoices.length) {
        await Invoice.updateMany(
          { _id: { $in: laterInvoices.map((i) => i._id) } },
          { $set: { customerType: 'returning' } }
        );
      }
    }
  });

  console.log(`\n--- Summary ---`);
  console.log(`Customers processed:                                 ${processed}`);
  console.log(`Earliest invoice confirmed "new" by Zenoti:          ${newConfirmed}`);
  console.log(`Earliest invoice flipped to "returning" by Zenoti:   ${returningTagged}`);
  console.log(`Zenoti lookup failed/inconclusive - fell back to db: ${newFellBackToDb}`);
  console.log(`No email on file - fell back to db:                  ${noEmail}`);
  console.log(DRY_RUN ? '\nDry run - nothing written.' : '\nWritten.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});