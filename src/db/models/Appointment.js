const { Schema, model } = require('mongoose');

const appointmentSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
  zenotiGuestId: String,
  zenotiAppointmentGroupId: { type: String, required: true },
  status: { type: String, default: 'created' }, // created | cancelled | rescheduled
  cancelledAt: { type: Date, default: null },
  // Zenoti's real field names for these aren't confirmed from an actual
  // payload yet (support described the trigger and concept, not the exact
  // JSON) - populated defensively, best-guess snake_case matching the rest
  // of this payload's convention. Correct these once a real event lands -
  // check RawEvent for eventType "appointment.status_changed".
  wasRescheduled: { type: Boolean, default: false },
  originalAppointmentDate: { type: Date, default: null },
  // Set on the NEW appointment created by a rebooking, pointing back at the
  // group id it replaced. The OLD appointment gets status: 'rescheduled' so
  // it drops out of Upcoming without two rows existing for one real visit.
  rebookedFromGroupId: { type: String, default: null },
  zenotiStatus: { type: String, default: null }, // raw status string, for reference/debugging
  // When Zenoti sent this booking event - for an online booking with
  // upfront payment/deposit, this is effectively the payment moment too,
  // since Zenoti doesn't send a separate "payment confirmed" timestamp.
  bookedAt: { type: Date, default: null },
  // Denormalized at booking time (from AppointmentGroup.Created) so the
  // upcoming-bookings list doesn't need to reach back into Zenoti later.
  appointmentDate: { type: Date, default: null }, // earliest service start time, in-center
  serviceNames: { type: [String], default: [] },
  centerName: { type: String, default: null },
  // Zenoti already assigns the invoice at booking time, before it's closed -
  // handy for cross-referencing against the Invoice collection once/if it
  // closes, but note no Invoice document exists here yet at booking time.
  zenotiInvoiceId: { type: String, default: null },
  invoiceNumber: { type: String, default: null },
  // The Visit created from this same booking event's UTM params, if any -
  // this is the ad source/campaign attributed to this specific booking,
  // straight from Zenoti's booking-link UTMs, not a later guess.
  visitId: { type: Schema.Types.ObjectId, ref: 'Visit', default: null },
}, { timestamps: true });

appointmentSchema.index({ brandId: 1, zenotiAppointmentGroupId: 1 });
appointmentSchema.index({ brandId: 1, appointmentDate: 1 });

module.exports = model('Appointment', appointmentSchema);