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
// Unique (not just indexed) wherever zenotiGuestId is actually set - closes
// the race in identityResolution.js where two near-simultaneous webhooks
// for the same guest (e.g. appointment.created and invoice.closed arriving
// a few ms apart) each found no existing Customer and both created one,
// splitting one real person across two docs (seen live: Tia Bell, one doc
// had her email/phone, the other - the one an invoice ended up pointing at
// - had neither). partialFilterExpression so the many Customer docs with
// no zenotiGuestId at all (identified only by email, never linked to
// Zenoti) don't collide with each other on an implicit null-equals-null.
customerSchema.index(
  { brandId: 1, zenotiGuestId: 1 },
  { unique: true, partialFilterExpression: { zenotiGuestId: { $type: 'string' } } },
);

const Customer = model('Customer', customerSchema);

// Mongoose builds indexes in the background on connect and only reports
// failure through this event - nothing throws, nothing rejects a promise
// anywhere else. That's exactly how the brandId+zenotiGuestId unique index
// above silently downgraded to a plain non-unique index (duplicates
// already existed in the collection when it was added) without anyone
// noticing, until a guest's Customer doc split in two (seen live: Tia
// Bell, then Niki Mira). Log it loudly so that can't happen again unseen -
// see checkGuestIdIndex.js / rebuildGuestIdIndex.js for how this was found
// and fixed on 2026-10-17.
Customer.on('index', (err) => {
  if (err) console.error('Customer index build failed:', err.message);
});

module.exports = Customer;