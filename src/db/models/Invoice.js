const { Schema, model } = require('mongoose');

const invoiceSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', default: null },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
  zenotiInvoiceId: { type: String, required: true },
  // Human-readable Zenoti number, e.g. "CH18816" (prefix + invoice_number).
  invoiceNumber: { type: String, default: null },
  amount: { type: Number, required: true },
  isRefund: { type: Boolean, default: false },
  // No hardcoded default here anymore - zenotiWebhook.js now always sets
  // this explicitly from the brand's configured currency (see Brand.js).
  currency: { type: String, required: true },
  status: { type: String, default: 'closed' },
  closedAt: { type: Date, default: Date.now },
  centerId: { type: String, default: null },
  centerName: { type: String, default: null },
items: [{
    name: { type: String, required: true },
    price: { type: Number, required: true },
  }],
  tax: { type: Number, default: 0 },
  // Idempotency guard for conversionService.js.
  conversionsProcessedAt: { type: Date, default: null },
  // Set once, at invoice-close time, in conversionService.js -
  // 'new' if this was the customer's first-ever closed invoice in OUR db at
  // that moment, 'returning' otherwise. Stays null for invoices that are
  // still open (set only when conversions are processed on close).
  // reconcileCustomerTypeViaZenoti.js later corrects any 'new' tag to
  // 'returning' if Zenoti's own 2-year history shows an earlier purchase we
  // didn't know about (e.g. a pre-tracking-era customer) - see that script.
  customerType: { type: String, enum: ['new', 'returning', null], default: null },
}, { timestamps: true });

invoiceSchema.index({ brandId: 1, zenotiInvoiceId: 1 }, { unique: true });

module.exports = model('Invoice', invoiceSchema);