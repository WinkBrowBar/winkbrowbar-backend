// checkCallLeadMatches.js  (read-only)
//
// For every CallLead in a date range, shows whether the call-lead -> Google
// attribution in conversionService.js actually fired, and if not, why.
//
// Usage:
//   node checkCallLeadMatches.js --brand=<brandId or slug> [--from=2026-10-23] [--to=2026-10-29]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const CallLead = require('./src/db/models/CallLead');
const Customer = require('./src/db/models/Customer');
const Invoice = require('./src/db/models/Invoice');
const Appointment = require('./src/db/models/Appointment');
const Conversion = require('./src/db/models/Conversion');
const { normalizePhone, utcMidnight } = require('./src/services/callLeadMatching');

const DAY = 24 * 60 * 60 * 1000;
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const d = (x) => (x ? new Date(x).toISOString().slice(0, 16).replace('T', ' ') : '-');

(async () => {
  const brandArg = arg('brand');
  if (!brandArg) { console.error('Usage: node checkCallLeadMatches.js --brand=<id|slug> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]'); process.exit(1); }
  await connectDB();
  const brand = mongoose.isValidObjectId(brandArg) ? await Brand.findById(brandArg) : await Brand.findOne({ slug: brandArg });
  if (!brand) { console.error(`No brand "${brandArg}"`); process.exit(1); }

  const q = { brandId: brand._id };
  if (arg('from') || arg('to')) {
    q.callDate = {};
    if (arg('from')) q.callDate.$gte = new Date(arg('from'));
    if (arg('to')) q.callDate.$lte = new Date(arg('to'));
  }
  const leads = await CallLead.find(q).sort({ callDate: 1 }).lean();

  // Customer.phone formats vary ("+1 2025551234", "(202) 555-1234") - index by normalized last-10.
  const byPhone = new Map();
  for (const c of await Customer.find({ brandId: brand._id, phone: { $nin: [null, ''] } }).lean()) {
    const p = normalizePhone(c.phone);
    if (p) byPhone.set(p, [...(byPhone.get(p) || []), c]);
  }

  const tally = {};
  for (const lead of leads) {
    console.log(`\n=== ${lead.callDate.toISOString().slice(0, 10)}  ${lead.phone}  ${lead.callerName || ''}  (lead imported ${d(lead.createdAt)})`);
    const customers = byPhone.get(lead.phone) || [];
    if (!customers.length) { console.log('  -> NO CUSTOMER with this phone in db'); tally.noCustomer = (tally.noCustomer || 0) + 1; continue; }

    const callDay = utcMidnight(lead.callDate).getTime();
    const invoices = await Invoice.find({
      brandId: brand._id,
      customerId: { $in: customers.map((c) => c._id) },
      closedAt: { $gte: new Date(callDay - 7 * DAY), $lte: new Date(callDay + 45 * DAY) },
    }).sort({ closedAt: 1 }).lean();
    const appts = await Appointment.find({
      brandId: brand._id,
      customerId: { $in: customers.map((c) => c._id) },
      bookedAt: { $gte: new Date(callDay - DAY), $lte: new Date(callDay + 2 * DAY) },
    }).lean();

    console.log(`  customer(s): ${customers.map((c) => `${c.name || '?'} [${c._id}]`).join(', ')}`);
    for (const a of appts) console.log(`  appt booked ${d(a.bookedAt)} for ${d(a.appointmentDate)}  inv ${a.invoiceNumber || '-'}  status ${a.status}`);
    if (!invoices.length) { console.log('  -> NO INVOICE in [call-7d, call+45d]'); tally.noInvoice = (tally.noInvoice || 0) + 1; continue; }

    for (const inv of invoices) {
      const convs = await Conversion.find({ invoiceId: inv._id, platform: { $ne: 'klaviyo' } }).lean();
      const conv = convs[0];
      const inWindow = Math.abs(utcMidnight(inv.closedAt).getTime() - callDay) <= DAY;
      const leadBeforeProcessing = inv.conversionsProcessedAt ? lead.createdAt <= inv.conversionsProcessedAt : null;

      let verdict;
      if (inv.isRefund) verdict = 'refund - skipped by design';
      else if (inv.status !== 'closed') verdict = 'invoice still OPEN - not processed yet';
      else if (!conv) verdict = 'closed but NO conversion row';
      else if (conv.attributionModelUsed === 'call_lead_phone_match') verdict = 'MATCHED -> google_call (call lead)';
      else if (conv.platform !== 'direct') verdict = `credited to ${conv.platform} (tracked visit takes priority over call lead)`;
      else {
        const why = [];
        if (!inWindow) why.push('close date outside +-1 day of call');
        if (leadBeforeProcessing === false) why.push('lead imported AFTER invoice was processed');
        verdict = `MISSED -> direct (${why.join('; ') || 'unknown - investigate'})`;
      }
      console.log(`  inv ${inv.invoiceNumber || inv.zenotiInvoiceId}  $${inv.amount}  closed ${d(inv.closedAt)}  processed ${d(inv.conversionsProcessedAt)}  ${inv.centerName || ''}`);
      console.log(`    -> ${verdict}`);
      const key = verdict.split(' ')[0];
      tally[key] = (tally[key] || 0) + 1;
    }
  }
  console.log('\nSUMMARY', { leads: leads.length, ...tally });
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });