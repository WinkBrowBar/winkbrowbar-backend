const { Schema, model } = require('mongoose');

// Log for the Inventory page's Logs tab: links saved, previews, every Apply (with each change and
// failure), blocked applies and server errors. Entries expire after 180 days.
const inventoryActivitySchema = new Schema({
  type: { type: String, required: true }, // links_saved | preview | apply | apply_blocked | error
  who: String,
  summary: String,
  data: Schema.Types.Mixed,
}, { timestamps: { createdAt: true, updatedAt: false } });

inventoryActivitySchema.index({ createdAt: -1 });
inventoryActivitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

module.exports = model('InventoryActivity', inventoryActivitySchema);