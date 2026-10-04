const { Schema, model } = require('mongoose');

// Ad spend pulled from each platform's own reporting/insights API - separate
// from Conversion, which only ever holds revenue we're reporting TO a
// platform, never spend we're pulling FROM one. CAC needs both sides.
const adSpendSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  platform: { type: String, required: true, enum: ['meta', 'google'] }, // only platforms with real ad spend - AWIN is commission-based (already captured via Conversion), Klaviyo has no spend concept
  date: { type: Date, required: true }, // the day this spend applies to
  campaignId: { type: String, default: null },
  campaignName: { type: String, default: null },
  spend: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
}, { timestamps: true });

// One row per brand+platform+campaign+day - re-syncing overwrites rather than duplicates.
adSpendSchema.index({ brandId: 1, platform: 1, campaignId: 1, date: 1 }, { unique: true });

module.exports = model('AdSpend', adSpendSchema);