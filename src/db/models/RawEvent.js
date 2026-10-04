const { Schema, model } = require('mongoose');

const rawEventSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  source: { type: String, required: true }, // zenoti | shopify
  eventType: String,
  payload: { type: Schema.Types.Mixed, required: true },
  processed: { type: Boolean, default: false },
  processedAt: Date,
  receivedAt: { type: Date, default: Date.now },
  // Set whenever handleEvent() throws, so a failed event is diagnosable
  // instead of only ever logged to console (which nobody watches). Cleared
  // back to null the moment reprocessing succeeds.
  processingError: { type: String, default: null },
  processingAttempts: { type: Number, default: 0 },
  lastAttemptAt: { type: Date, default: null },
});

rawEventSchema.index({ processed: 1 });

module.exports = model('RawEvent', rawEventSchema);