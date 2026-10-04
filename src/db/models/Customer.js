const { Schema, model } = require('mongoose');

const customerSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  email: String,
  phone: String,
  name: String,
  zenotiGuestId: String,

  // First-touch is set once and never overwritten - enforced in identityResolution.js
  firstTouchVisitId: { type: Schema.Types.ObjectId, ref: 'Visit', default: null },
  // Latest-touch always refreshes on every new linked visit
  latestTouchVisitId: { type: Schema.Types.ObjectId, ref: 'Visit', default: null },

  firstPurchaseDate: { type: Date, default: null },
  // Updated on EVERY closed invoice (unlike firstPurchaseDate, which is set
  // once and never overwritten). This is what powers "most recent purchase"
  // sorting in the customers list - without it, the dashboard has no way to
  // put the customer who just walked in today above one who bought once
  // eight months ago.
  lastPurchaseDate: { type: Date, default: null },
  lifetimeRevenue: { type: Number, default: 0 },
}, { timestamps: true });

customerSchema.index({ brandId: 1, email: 1 });
customerSchema.index({ brandId: 1, phone: 1 });
customerSchema.index({ brandId: 1, zenotiGuestId: 1 });

module.exports = model('Customer', customerSchema);
