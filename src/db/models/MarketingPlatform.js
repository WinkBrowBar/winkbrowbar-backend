const { Schema, model } = require('mongoose');

const marketingPlatformSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  platform: { type: String, required: true, enum: ['meta', 'google', 'awin', 'klaviyo'] },
  // credentials shape varies by platform. For CAC/spend-fetching (meta),
  // credentials also needs `adAccountId` alongside the existing `pixelId`/
  // `accessToken` used for conversion sending - these are two different
  // Meta permissions (ads_read vs the Conversions API scope), so the
  // existing accessToken may need `ads_read` added before fetchSpend works.
  credentials: { type: Schema.Types.Mixed, default: {} },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

marketingPlatformSchema.index({ brandId: 1, platform: 1 }, { unique: true });

module.exports = model('MarketingPlatform', marketingPlatformSchema);