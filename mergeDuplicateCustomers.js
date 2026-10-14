// mergeDuplicateCustomers.js
//
// Cleans up Customer docs split by the identityResolution.js race fixed
// alongside this script: two near-simultaneous webhooks for the same
// Zenoti guest (e.g. appointment.created and invoice.closed/guest.updated
// landing a few ms apart) could each find no existing Customer and both
// create one, splitting one real person across two docs with the same
// zenotiGuestId - seen live: Tia Bell had one doc with her email/phone and
// a separate, emptier one that an invoice happened to point at, showing
// "-" for email on Transactions despite Zenoti having it.
//
// For every zenotiGuestId with more than one Customer doc:
//   - picks a PRIMARY: prefers the one with an email, then phone, then the
//     oldest (lowest _id) as a tiebreak
//   - backfills any email/phone/name the primary is missing from whichever
//     duplicate has it
//   - reassigns every Visit/Appointment/Invoice pointing at a duplicate
//     over to the primary (same reassignment the guest.merged handler in
//     zenotiWebhook.js already does for Zenoti-side merges)
//   - sums lifetimeRevenue, takes the earliest firstPurchaseDate and latest
//     lastPurchaseDate across all docs in the group
//   - keeps the primary's firstTouchVisitId if it has one, else backfills
//     from a duplicate
//   - deletes the duplicate doc(s)
//
// Usage:
//   node mergeDuplicateCustomers.js --brand=<brandId or slug> [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Customer = require('./src/db/models/Customer');
const Visit = require('./src/db/models/Visit');
const Appointment = require('./src/db/models/Appointment');
const Invoice = require('./src/db/models/Invoice');

const DRY_RUN = process.argv.includes('--dry-run');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  const brandArg = argValue('brand');
  if (!brandArg) {
    console.error('Usage: node mergeDuplicateCustomers.js --brand=<brandId or slug> [--dry-run]');
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

  const customers = await Customer.find({ brandId: brand._id, zenotiGuestId: { $exists: true, $ne: null } }).sort({ _id: 1 }).lean();

  const groups = new Map();
  for (const c of customers) {
    if (!groups.has(c.zenotiGuestId)) groups.set(c.zenotiGuestId, []);
    groups.get(c.zenotiGuestId).push(c);
  }

  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  console.log(`\n${customers.length} customer(s) with a zenotiGuestId. ${dupGroups.length} guest(s) split across multiple Customer docs.\n`);

  for (const group of dupGroups) {
    const sorted = [...group].sort((a, b) => {
      const aScore = (a.email ? 2 : 0) + (a.phone ? 1 : 0);
      const bScore = (b.email ? 2 : 0) + (b.phone ? 1 : 0);
      if (aScore !== bScore) return bScore - aScore;
      return String(a._id).localeCompare(String(b._id));
    });
    const [primary, ...dupes] = sorted;

    console.log(`Guest ${group[0].zenotiGuestId} (${primary.name || '—'}): keeping ${primary._id} (email=${primary.email || '—'}), merging in ${dupes.map((d) => d._id).join(', ')}`);

    const patch = {};
    if (!primary.email) { const d = dupes.find((d) => d.email); if (d) patch.email = d.email; }
    if (!primary.phone) { const d = dupes.find((d) => d.phone); if (d) patch.phone = d.phone; }
    if (!primary.name) { const d = dupes.find((d) => d.name); if (d) patch.name = d.name; }
    if (!primary.firstTouchVisitId) { const d = dupes.find((d) => d.firstTouchVisitId); if (d) patch.firstTouchVisitId = d.firstTouchVisitId; }

    const allLifetimeRevenue = group.reduce((sum, c) => sum + (c.lifetimeRevenue || 0), 0);
    patch.lifetimeRevenue = allLifetimeRevenue;

    const firstDates = group.map((c) => c.firstPurchaseDate).filter(Boolean);
    if (firstDates.length) patch.firstPurchaseDate = new Date(Math.min(...firstDates.map((d) => new Date(d))));
    const lastDates = group.map((c) => c.lastPurchaseDate).filter(Boolean);
    if (lastDates.length) patch.lastPurchaseDate = new Date(Math.max(...lastDates.map((d) => new Date(d))));

    const dupeIds = dupes.map((d) => d._id);

    if (!DRY_RUN) {
      await Customer.updateOne({ _id: primary._id }, { $set: patch });
      await Visit.updateMany({ customerId: { $in: dupeIds } }, { $set: { customerId: primary._id } });
      await Appointment.updateMany({ customerId: { $in: dupeIds } }, { $set: { customerId: primary._id } });
      await Invoice.updateMany({ customerId: { $in: dupeIds } }, { $set: { customerId: primary._id } });
      await Customer.deleteMany({ _id: { $in: dupeIds } });
    }
  }

  console.log(DRY_RUN ? '\nDry run - nothing written.' : '\nMerged and written.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
