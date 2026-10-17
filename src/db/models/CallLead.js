const { Schema, model } = require('mongoose');

// A phone call Google Ads reported in its own call-reporting dashboard
// (not a webhook or anything auto-captured - manually exported from Google
// Ads and imported via importGoogleCallLeads.js). Lets conversionService.js
// attribute a later invoice to 'google' for a customer who called in,
// instead of defaulting to 'direct' just because no web Visit exists for
// them. Forward-only by design (decision 2026-10-17): no backfill against
// invoices already processed before this existed - only invoices processed
// from here on consult this collection.
const callLeadSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  // Last-10-digits normalized (see normalizePhone in importGoogleCallLeads.js
  // and callLeadMatching.js) so formatting differences between Google Ads'
  // export and Customer.phone (e.g. "+1 2025551234" vs "(202) 555-1234")
  // don't prevent a real match.
  phone: { type: String, required: true },
  rawPhone: String, // as it appeared in the imported sheet, for troubleshooting
  callerName: String,
  // Calendar date Google Ads reported for the call, normalized to UTC
  // midnight - time-of-day isn't trustworthy/comparable across sources, so
  // matching is done by calendar day (see callLeadMatching.js).
  callDate: { type: Date, required: true },
  source: { type: String, default: 'google_ads' },
}, { timestamps: true });

// Importing the same sheet twice (or an overlapping export) shouldn't create
// duplicate rows for the same call.
callLeadSchema.index({ brandId: 1, phone: 1, callDate: 1 }, { unique: true });

module.exports = model('CallLead', callLeadSchema);