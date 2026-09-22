const { Schema, model } = require('mongoose');

const brandSchema = new Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  shopifyStoreUrl: String,
  // Populated automatically once the Shopify OAuth install flow completes
  shopifyAccessToken: String,
  shopifyScopes: String,
  // A separate, low-privilege token safe to embed in public-facing scripts
  // (the Shopify tracking snippet). Unlike INTERNAL_API_KEY, this can ONLY
  // be used to write new visits via /api/attribution/capture - it cannot
  // read, update, or delete anything. Generate with crypto.randomBytes.
  publicCaptureToken: { type: String, index: true },
  zenotiCenterId: String,
  // Currency this brand's Zenoti invoices/AWIN transactions are reported in.
  // Was previously hardcoded to 'INR' inside zenotiWebhook.js regardless of
  // brand - wrong for USD brands like Wink Brow Bar. Now read per-brand.
  currency: { type: String, default: 'USD' },
  attributionModel: { type: String, default: 'last_touch' }, // last_touch | first_touch | linear
  // How many days a tracked click stays eligible to receive credit for a
  // later purchase. Without this, a months-old ad click could still get
  // credited for a purchase that almost certainly had nothing to do with
  // it. 30 mirrors Meta's own default click-through attribution window.
  attributionWindowDays: { type: Number, default: 30 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = model('Brand', brandSchema);