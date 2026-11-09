const { Schema, model } = require('mongoose');

// The Zenoti <-> Shopify product links chosen on the dashboard's Inventory page.
// Single document (key 'wink'): links = { zenotiProductCode: [shopifyVariantId, ...] },
// ignore = Zenoti codes marked "don't sync". Both product LISTS are always fetched live;
// only these links are stored.
const inventoryLinksSchema = new Schema({
  key: { type: String, required: true, unique: true, default: 'wink' },
  links: { type: Schema.Types.Mixed, default: {} },
  ignore: { type: [String], default: [] },
  savedBy: String,
}, { timestamps: true, minimize: false });

module.exports = model('InventoryLinks', inventoryLinksSchema);