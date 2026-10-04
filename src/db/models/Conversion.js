const { Schema, model } = require('mongoose');

const conversionSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
  attributionVisitId: { type: Schema.Types.ObjectId, ref: 'Visit', default: null },
  attributionModelUsed: String,
  platform: { type: String, required: true },
  amount: { type: Number, required: true },
  eventTime: { type: Date, required: true },
  status: { type: String, default: 'pending' }, // pending | sent | failed
  platformResponse: Schema.Types.Mixed,
  sentAt: Date,
}, { timestamps: true });

// One conversion per (invoice, platform), full stop.
conversionSchema.index({ invoiceId: 1, platform: 1 }, { unique: true });

module.exports = model('Conversion', conversionSchema);