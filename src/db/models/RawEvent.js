const { Schema, model } = require('mongoose');

const rawEventSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  source: { type: String, required: true }, // zenoti | shopify
  eventType: String,
  payload: { type: Schema.Types.Mixed, required: true },
  processed: { type: Boolean, default: false },
  processedAt: Date,
  receivedAt: { type: Date, default: Date.now },
});

rawEventSchema.index({ processed: 1 });

module.exports = model('RawEvent', rawEventSchema);
