// findInstagramLead.js
//
// Searches for an Instagram-sourced lead across Visits, Customers, and
// Appointments - a "lead" could mean any of these depending on how far it
// got (just a tracked visit, an identified customer, or a real booking).
// Matches utmSource loosely (instagram, ig, insta) since different sources
// tag it differently (Zenoti's own widget vs our own tracking script).
//
// Usage:
//   node findInstagramLead.js --brand=<brandId or slug> [--email=someone@example.com] [--name="Jane Doe"]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Visit = require('./src/db/models/Visit');
const Customer = require('./src/db/models/Customer');
const Appointment = require('./src/db/models/Appointment');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  const brandArg = argValue('brand');
  const email = argValue('email');
  const name = argValue('name');
  if (!brandArg) {
    console.error('Usage: node findInstagramLead.js --brand=<brandId or slug> [--email=...] [--name="..."]');
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

  const igRegex = /instagram|^ig$|insta/i;

  const visitMatch = { brandId: brand._id, utmSource: igRegex };
  const visits = await Visit.find(visitMatch).sort({ capturedAt: -1 }).limit(50).lean();

  console.log(`\n--- Visits tagged Instagram (most recent 50) ---`);
  console.log(`${visits.length} found.\n`);
  for (const v of visits) {
    console.log(`${v.capturedAt?.toISOString() || '—'}  customerId=${v.customerId || 'null'}  medium=${v.utmMedium || '—'}  campaign=${v.utmCampaign || '—'}  visitorId=${v.visitorId}`);
  }

  if (email || name) {
    const customerMatch = { brandId: brand._id };
    if (email) customerMatch.email = new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (name) customerMatch.name = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const customers = await Customer.find(customerMatch).lean();
    console.log(`\n--- Customer match (${email ? 'email' : 'name'}: "${email || name}") ---`);
    console.log(`${customers.length} found.\n`);
    for (const c of customers) {
      console.log(`Customer ${c._id}: ${c.name || '—'} <${c.email || '—'}> firstTouchVisitId=${c.firstTouchVisitId || 'null'} latestTouchVisitId=${c.latestTouchVisitId || 'null'}`);

      const theirVisits = await Visit.find({ brandId: brand._id, customerId: c._id }).sort({ capturedAt: 1 }).lean();
      console.log(`  ${theirVisits.length} visit(s):`);
      for (const v of theirVisits) {
        console.log(`    ${v.capturedAt?.toISOString()}  source=${v.utmSource || '—'}  medium=${v.utmMedium || '—'}  campaign=${v.utmCampaign || '—'}`);
      }

      const theirAppts = await Appointment.find({ brandId: brand._id, customerId: c._id }).sort({ bookedAt: 1 }).lean();
      console.log(`  ${theirAppts.length} appointment(s):`);
      for (const a of theirAppts) {
        console.log(`    bookedAt=${a.bookedAt?.toISOString() || '—'}  status=${a.status}  invoice=${a.invoiceNumber || '—'}  zenotiInvoiceId=${a.zenotiInvoiceId || '—'}  appointmentDate=${a.appointmentDate?.toISOString() || '—'}`);
      }
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
