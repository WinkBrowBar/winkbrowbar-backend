const { Schema, model } = require('mongoose');

const appointmentSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
  zenotiGuestId: String,
  zenotiAppointmentGroupId: { type: String, required: true },
  status: { type: String, default: 'created' },
}, { timestamps: true });

appointmentSchema.index({ brandId: 1, zenotiAppointmentGroupId: 1 });

module.exports = model('Appointment', appointmentSchema);
