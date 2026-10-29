const CallLead = require('../db/models/CallLead');

// Last 10 digits only - absorbs +1/1/country-code and formatting
// differences between Google Ads' export and however Customer.phone or
// Zenoti happened to store the number (see extractGuestPhone in
// zenotiGuestLookup.js for the kind of variation already seen there).
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function utcMidnight(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Finds a call-log row for this phone whose sheet date is within +-1 day of
// `aroundDate` - the invoice's PAID date (Invoice.closedAt). Same phone +
// sheet date within +-1 day of payment = a Google call lead.
async function findMatchingCallLead({ brandId, phone, aroundDate }) {
  const normalized = normalizePhone(phone);
  if (!normalized || !aroundDate) return null;

  const center = utcMidnight(aroundDate).getTime();
  return CallLead.findOne({
    brandId,
    phone: normalized,
    callDate: { $gte: new Date(center - DAY_MS), $lte: new Date(center + DAY_MS) },
  }).sort({ callDate: 1 });
}

// Run after every sheet sync: the sheet is filled in after the fact, so most
// invoices already closed (and were labeled 'direct') before their call row
// existed. Re-checks 'direct' sales against call leads from the last
// `sinceDays` and relabels matches 'google_call'. Idempotent - only ever
// touches 'direct' rows, so re-syncing the same sheet changes nothing.
async function rematchDirectSalesToCallLeads(brand, { sinceDays = 60 } = {}) {
  const Customer = require('../db/models/Customer');
  const Conversion = require('../db/models/Conversion');
  const Invoice = require('../db/models/Invoice');

  const leads = await CallLead.find({ brandId: brand._id, callDate: { $gte: new Date(Date.now() - sinceDays * DAY_MS) } }).lean();
  const leadPhones = new Set(leads.map((l) => l.phone));
  if (!leadPhones.size) return { matched: 0, invoices: [] };

  const phoneByCustomer = new Map();
  for (const c of await Customer.find({ brandId: brand._id, phone: { $nin: [null, ''] } }, { phone: 1 }).lean()) {
    const p = normalizePhone(c.phone);
    if (leadPhones.has(p)) phoneByCustomer.set(String(c._id), p);
  }
  if (!phoneByCustomer.size) return { matched: 0, invoices: [] };

  const directConvs = await Conversion.find({ brandId: brand._id, platform: 'direct', customerId: { $in: [...phoneByCustomer.keys()] } });
  const invoices = [];
  for (const conv of directConvs) {
    const invoice = await Invoice.findById(conv.invoiceId).lean();
    if (!invoice || invoice.isRefund || invoice.status !== 'closed') continue;
    const lead = await findMatchingCallLead({
      brandId: brand._id,
      phone: phoneByCustomer.get(String(conv.customerId)),
      aroundDate: invoice.closedAt,
    });
    if (!lead) continue;
    conv.platform = 'google_call';
    conv.attributionModelUsed = 'call_lead_phone_match';
    await conv.save();
    invoices.push(invoice.invoiceNumber || invoice.zenotiInvoiceId);
  }
  return { matched: invoices.length, invoices };
}

module.exports = { normalizePhone, utcMidnight, findMatchingCallLead, rematchDirectSalesToCallLeads };