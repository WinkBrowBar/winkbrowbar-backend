// dedupeDuplicateAppointments.js
//
// Cleans up Appointment docs created before the zenotiWebhook.js fix
// (appointment.created used to be a bare Appointment.create() with no
// check for an existing zenotiAppointmentGroupId - a redelivered webhook
// from Zenoti created a second, identical row for the same real booking,
// e.g. invoice CH19945 showing twice on Upcoming Bookings on 2026-10-14).
//
// Groups by (brandId, zenotiAppointmentGroupId), and for any group with
// more than one doc, keeps exactly one and deletes the rest:
//   - prefers a doc with customerType already set (more "complete") over
//     one that's still null
//   - ties broken by keeping the OLDEST (lowest _id / createdAt) - no
//     reason to prefer a later duplicate
//
// Usage:
//   node dedupeDuplicateAppointments.js --brand=<brandId or slug> [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Appointment = require('./src/db/models/Appointment');

const DRY_RUN = process.argv.includes('--dry-run');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  const brandArg = argValue('brand');
  if (!brandArg) {
    console.error('Usage: node dedupeDuplicateAppointments.js --brand=<brandId or slug> [--dry-run]');
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

  const appointments = await Appointment.find({ brandId: brand._id }).sort({ _id: 1 }).lean();

  const groups = new Map();
  for (const appt of appointments) {
    const key = appt.zenotiAppointmentGroupId;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(appt);
  }

  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  const totalExtra = dupGroups.reduce((sum, g) => sum + (g.length - 1), 0);

  console.log(`\n${appointments.length} total appointment(s). ${dupGroups.length} group(s) with duplicates, ${totalExtra} extra doc(s) to remove.\n`);

  const idsToDelete = [];
  for (const group of dupGroups) {
    const sorted = [...group].sort((a, b) => {
      const aHas = a.customerType ? 0 : 1;
      const bHas = b.customerType ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      return String(a._id).localeCompare(String(b._id));
    });
    const [keep, ...drop] = sorted;
    console.log(`Group ${group[0].zenotiAppointmentGroupId} (invoice ${group[0].invoiceNumber || '—'}): keeping ${keep._id}, dropping ${drop.map((d) => d._id).join(', ')}`);
    idsToDelete.push(...drop.map((d) => d._id));
  }

  if (!DRY_RUN && idsToDelete.length) {
    const { deletedCount } = await Appointment.deleteMany({ _id: { $in: idsToDelete } });
    console.log(`\nDeleted ${deletedCount} duplicate(s).`);
  } else {
    console.log(DRY_RUN ? '\nDry run - nothing deleted.' : '\nNothing to delete.');
  }
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});