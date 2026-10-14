
// backfillUpcomingCustomerType.js
//
// One-off fix for the "—" customerType on Upcoming Bookings. Those rows are
// Appointment documents - appointmentDate >= now, customerType still null
// because they were booked BEFORE the appointment.created webhook handler
// started calling determineCustomerType at booking time. Nothing will ever
// backfill them on its own: they're not invoices, so
// backfillCustomerTypeViaZenoti.js (which only touches Invoice) never
// reaches them, and once their appointmentDate passes or they get invoiced
// they fall out of Upcoming entirely - there was no point writing a
// standing backfill for a list this transient, but a one-time pass over
// what's open RIGHT NOW is cheap and clears the board immediately instead
// of waiting on these to roll off naturally.
//
// Same lookup used everywhere else (determineCustomerType -> real
// appointment/invoice history first, guest created_date fallback). Only
// touches Appointment rows where customerType is still null - never
// overwrites one the live webhook already set.
//
// Usage:
//   node backfillUpcomingCustomerType.js --brand=<brandId or slug> [--delay=1200] [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Appointment = require('./src/db/models/Appointment');
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
    console.error('Usage: node backfillUpcomingCustomerType.js --brand=<brandId or slug> [--delay=1200] [--dry-run]');
    process.exit(1);
  }
  const delayMs = Number(argValue('delay')) || 1200;
  const COOLDOWN_MS = 65000;

  await connectDB();

  const brand = mongoose.isValidObjectId(brandArg)
    ? await Brand.findById(brandArg)
    : await Brand.findOne({ slug: brandArg });
  if (!brand) {
    console.error(`No brand found for "${brandArg}"`);
    process.exit(1);
  }

  const appointments = await Appointment.find({
    brandId: brand._id,
    status: { $in: ['created', 'cancelled'] },
    customerType: null,
  }).sort({ appointmentDate: 1 }).lean();

  console.log(`\n${appointments.length} open appointment(s) with no customerType yet (delay=${delayMs}ms between requests)...\n`);

  let taggedNew = 0;
  let taggedReturning = 0;
  let noSignal = 0;
  let consecutiveMisses = 0;

  for (const [i, appt] of appointments.entries()) {
    const customer = appt.customerId ? await Customer.findById(appt.customerId).lean() : null;

    let zenotiType = null;
    if (customer && (customer.email || customer.zenotiGuestId || appt.zenotiGuestId)) {
      zenotiType = await determineCustomerType({
        email: customer.email,
        zenotiGuestId: customer.zenotiGuestId || appt.zenotiGuestId,
        atDate: appt.bookedAt || appt.appointmentDate,
        excludeAppointmentGroupId: appt.zenotiAppointmentGroupId,
      });
    }

    if (zenotiType) {
      consecutiveMisses = 0;
      if (zenotiType === 'returning') taggedReturning++; else taggedNew++;
      if (!DRY_RUN) await Appointment.updateOne({ _id: appt._id }, { $set: { customerType: zenotiType } });
    } else {
      noSignal++;
      if (customer && (customer.email || customer.zenotiGuestId || appt.zenotiGuestId)) consecutiveMisses++;
    }

    if ((i + 1) % 50 === 0) console.log(`...${i + 1}/${appointments.length} (new: ${taggedNew}, returning: ${taggedReturning}, no signal: ${noSignal})`);

    if (consecutiveMisses >= 10) {
      console.log(`\n10 lookups in a row came back inconclusive - likely the 60/min rate limit. Cooling down ${COOLDOWN_MS / 1000}s (processed ${i + 1}/${appointments.length} so far)...`);
      await sleep(COOLDOWN_MS);
      consecutiveMisses = 0;
    }

    await sleep(delayMs);
  }

  console.log(`\n--- Summary ---`);
  console.log(`Tagged "new":                                   ${taggedNew}`);
  console.log(`Tagged "returning":                             ${taggedReturning}`);
  console.log(`No signal (no email/guest id, or lookup failed): ${noSignal}`);
  console.log(DRY_RUN ? '\nDry run - nothing written.' : '\nWritten.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});