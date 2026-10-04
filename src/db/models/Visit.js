const { Schema, model } = require('mongoose');

const visitSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null }, // null until identified
  visitorId: { type: String, required: true }, // our own cookie-based session id

  utmSource: String,
  utmMedium: String,
  utmCampaign: String,
  utmContent: String,
  utmTerm: String,
  landingPageUrl: String,
  referrer: String,

  gclid: String,
  fbclid: String,
  awinClickId: String,

  capturedAt: { type: Date, default: Date.now },
});

visitSchema.index({ brandId: 1, visitorId: 1 });
visitSchema.index({ customerId: 1 });

module.exports = model('Visit', visitSchema);
