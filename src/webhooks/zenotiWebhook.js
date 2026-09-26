const express = require('express');
const crypto = require('crypto');
const RawEvent = require('../db/models/RawEvent');
const Customer = require('../db/models/Customer');
const Appointment = require('../db/models/Appointment');
const Invoice = require('../db/models/Invoice');
const Brand = require('../db/models/Brand');
const { centerName } = require('../utils/centerNames');
const { resolveIdentity } = require('../services/identityResolution');
const { processInvoiceConversion } = require('../services/conversionService');
const router = express.Router();

function verifySignature(req) {
  const secret = process.env.ZENOTI_WEBHOOK_SECRET;
  if (!secret) return true;

  const header = req.headers['zenoti-webhook-signature'];
  if (!header) return false;

  const match = header.match(/sha256\s*=\s*([0-9a-f-]+)/i);
  if (!match) return false;

  const providedHex = match[1].replace(/-/g, '').toLowerCase();
  const expectedHex = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return providedHex === expectedHex;
}

router.post('/', async (req, res) => {
  console.log('ZENOTI TEST -> headers:', JSON.stringify(req.headers));
  console.log('ZENOTI TEST -> rawBody:', req.rawBody ? req.rawBody.toString() : '(no rawBody captured)');

  const isEmptyPing = !req.rawBody || req.rawBody.length === 0;
  if (isEmptyPing) {
    console.log('ZENOTI TEST -> empty ping accepted, skipping signature check');
    return res.status(200).json({ received: true, note: 'empty test ping accepted' });
  }

  if (!verifySignature(req)) {
    console.log('ZENOTI TEST -> signature check FAILED');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  console.log('ZENOTI TEST -> signature check passed');

  const brandId = req.query.brandId;
  if (!brandId) return res.status(400).json({ error: 'brandId query param required on webhook URL' });

  const event = req.body;
  const detectedType = detectEventType(event);

  const rawEvent = await RawEvent.create({
    brandId,
    source: 'zenoti',
    eventType: detectedType,
    payload: event,
  });

  res.status(202).json({ received: true });

  try {
    await handleEvent(brandId, event);
    rawEvent.processed = true;
    rawEvent.processedAt = new Date();
    await rawEvent.save();
  } catch (err) {
    console.error('Zenoti event processing failed', err);
  }
});

function detectEventType(event) {
  const rawType = (event.event_type || '').toLowerCase();
  if (rawType === 'invoice.closed') return 'invoice.closed';
  if (rawType === 'guest.created') return 'guest.created';
  if (rawType === 'guest.updated') return 'guest.updated';
  if (rawType === 'guest.merged') return 'guest.merged';
  if (rawType === 'appointmentgroup.created') return 'appointment.created';
  // Per Zenoti support: cancellations/reschedules aren't a separate event -
  // they come through the same generic "Appointment Group Status" trigger
  // that fires on ANY status change (confirmed, cancelled, no-show, etc).
  // The exact literal event_type string Zenoti sends for this trigger isn't
  // confirmed from a real payload yet, so this is matched broadly by
  // keyword rather than an exact string. This MUST run before the
  // shape-based fallback below, since a status-change payload likely still
  // has appointment_group_id + appointments and would otherwise be
  // misfiled as a brand-new booking.
  if (/status/.test(rawType) && /appointment/.test(rawType)) return 'appointment.status_changed';
  // Kept as a secondary catch-all in case a differently-named event exists
  // alongside the status trigger.
  if (/cancel|reschedul|delete|void|no.?show/.test(rawType)) return 'appointment.status_changed';

  const data = event.data || {};
  if (data.invoice) return 'invoice.closed';
  if (data.personal_info) {
    return data.created_date && data.created_date === data.last_updated
      ? 'guest.created'
      : 'guest.updated';
  }
  // Same defensive check on the shape-based fallback: an explicit
  // cancelled/status flag alongside the same appointment shape shouldn't
  // fall through to "created" just because event_type didn't match above.
  if (data.appointment_group_id && data.appointments) {
    const looksLikeStatusChange = data.is_cancelled === true
      || data.cancelled === true
      || data.is_appointment_rescheduled === 1
      || data.is_appointment_rescheduled === true
      || (typeof data.status === 'string' && /cancel|no.?show/i.test(data.status));
    return looksLikeStatusChange ? 'appointment.status_changed' : 'appointment.created';
  }
  if (data.merged_guest_id) return 'guest.merged';
  return 'unknown';
}

async function handleEvent(brandId, event) {
  const type = detectEventType(event);
  console.log('Handling Zenoti event:', type, 'for brandId:', brandId);
  const data = event.data || {};

  if (type === 'guest.created' || type === 'guest.updated') {
    const info = data.personal_info || {};
    const name = [info.first_name, info.last_name].filter(Boolean).join(' ');
    const phone = info.mobile_phone && info.mobile_phone.number
      ? `+${info.mobile_phone.phone_code} ${info.mobile_phone.number}`
      : null;
    await resolveIdentity({
      brandId,
      zenotiGuestId: data.id,
      email: info.email,
      phone,
      name,
    });
  }

  if (type === 'guest.merged') {
    const primaryGuestId = data.guest && data.guest.id;
    const mergedGuestId = data.merged_guest_id;
    const primaryCustomer = await Customer.findOne({ brandId, zenotiGuestId: primaryGuestId });
    const mergedCustomer = await Customer.findOne({ brandId, zenotiGuestId: mergedGuestId });
    if (primaryCustomer && mergedCustomer && String(primaryCustomer._id) !== String(mergedCustomer._id)) {
      const Visit = require('../db/models/Visit');
      await Visit.updateMany({ customerId: mergedCustomer._id }, { $set: { customerId: primaryCustomer._id } });
      await Appointment.updateMany({ customerId: mergedCustomer._id }, { $set: { customerId: primaryCustomer._id } });
      await Invoice.updateMany({ customerId: mergedCustomer._id }, { $set: { customerId: primaryCustomer._id } });
      primaryCustomer.lifetimeRevenue = (primaryCustomer.lifetimeRevenue || 0) + (mergedCustomer.lifetimeRevenue || 0);
      if (!primaryCustomer.firstTouchVisitId) primaryCustomer.firstTouchVisitId = mergedCustomer.firstTouchVisitId;
      await primaryCustomer.save();
      await mergedCustomer.deleteOne();

      // Conversion attribution runs exactly once, at the moment an invoice
      // closes. If this merge is happening AFTER an invoice already closed,
      // that invoice's ad-click visit (now reassigned above onto
      // primaryCustomer) was invisible at close time and got permanently
      // recorded as platform "direct" - never actually sent to any ad
      // platform. Re-check this merged customer's already-closed invoices
      // right now and send the real conversion if one is newly findable, so
      // this doesn't require a periodic manual reconciliation script to
      // ever catch it.
      const { pickAttributedVisit, platformFromVisit } = require('../services/attribution');
      const { sendToPlatform } = require('../services/conversionService');
      const Conversion = require('../db/models/Conversion');
      const closedInvoices = await Invoice.find({ brandId, customerId: primaryCustomer._id, status: 'closed' });
      for (const inv of closedInvoices) {
        const alreadySent = await Conversion.findOne({ invoiceId: inv._id, platform: { $in: ['google', 'meta', 'awin'] }, status: 'sent' });
        if (alreadySent) continue;
        const { visit, modelUsed } = await pickAttributedVisit({ brandId, customerId: primaryCustomer._id, beforeTimestamp: inv.closedAt });
        if (!visit) continue;
        const attribution = platformFromVisit(visit);
        if (!attribution) continue;
        // Same guard as the manual reconciliation script - a $0 or negative
        // invoice isn't a real sale to report to an ad platform.
        if (!(Number(inv.amount) > 0)) continue;
        await sendToPlatform({ brandId, invoice: inv, customer: primaryCustomer, platform: attribution.platform, clickId: attribution.clickId, visitId: visit._id, modelUsed });
      }
    }
  }

  if (type === 'appointment.created') {
    const guest = data.guest || {};
    let customer = null;
    if (guest.id) {
      customer = await resolveIdentity({
        brandId,
        zenotiGuestId: guest.id,
        email: guest.email,
        name: [guest.first_name, guest.last_name].filter(Boolean).join(' '),
      });
    }

    // Zenoti passes through the UTM params from the original booking URL
    // (winkbrowbar.zenoti.com/...?awc=...&utm_source=awin&utm_medium=...)
    // directly on this event, tied to this exact guest/appointment. This is
    // a more direct signal than relying on the browser's cross-domain
    // /identify call - no dependency on that JS having fired correctly, no
    // visitorId matching needed. Create an already-identified Visit right
    // here whenever this data is present.
    let visit = null;
    if (data.utm_source && customer) {
      const Visit = require('../db/models/Visit');
      // utm_medium already IS the AWIN click id in this org's setup
      // (packed as publisherId_timestamp_clickId, e.g.
      // "127709_1790078323_a5fd5e44f44eb52ac925379ed8503ccf") - use it
      // directly rather than re-splitting it, same value the old Zapier
      // flow extracted and sent to AWIN.
      //
      // Zenoti's OWN booking widget tags every booking it handles with a
      // fixed utm_source of "booknow" regardless of where the guest
      // actually came from - the real upstream source (e.g. "google",
      // "instagram") is what Zenoti put in utm_medium instead. Swap them
      // back to their real meaning here so "booknow" never shows up as if
      // it were an ad platform.
      const isZenotiWidget = data.utm_source === 'booknow';
      const realSource = isZenotiWidget ? (data.utm_medium || 'booknow') : data.utm_source;
      const realMedium = isZenotiWidget ? null : (data.utm_medium || null);
      const awinClickId = realSource === 'awin' ? (data.utm_medium || null) : null;

      visit = await Visit.create({
        brandId,
        customerId: customer._id,
        // No real browser visitorId is available from this server-to-server
        // event - synthesize a stable one scoped to this appointment group
        // so it never collides with a real cookie-based visitorId.
        visitorId: 'zenoti_' + data.appointment_group_id,
        utmSource: realSource,
        utmMedium: realMedium,
        awinClickId,
        // event_timestamp lives on the top-level Zenoti event, not inside
        // event.data - reading it off `data` here always came up empty and
        // silently fell back to server-processing time instead.
        capturedAt: event.event_timestamp ? new Date(event.event_timestamp) : new Date(),
      });

      if (!customer.firstTouchVisitId) customer.firstTouchVisitId = visit._id;
      customer.latestTouchVisitId = visit._id;
      await customer.save();
    }

    // The booking's own service list, tied to whichever center this
    // appointment group is at. start_time_in_center is used over start_time
    // since the latter can be in a different timezone; earliest wins when a
    // guest books multiple services back-to-back in one group.
    const appts = Array.isArray(data.appointments) ? data.appointments : [];
    const serviceNames = appts.map((a) => a.service_name).filter(Boolean);
    const startTimes = appts
      .map((a) => a.start_time_in_center || a.start_time)
      .filter(Boolean)
      .map((t) => new Date(t));
    const appointmentDate = startTimes.length ? new Date(Math.min(...startTimes)) : null;

    await Appointment.create({
      brandId,
      customerId: customer ? customer._id : null,
      zenotiGuestId: guest.id,
      zenotiAppointmentGroupId: data.appointment_group_id,
      status: 'created',
      bookedAt: event.event_timestamp ? new Date(event.event_timestamp) : new Date(),
      appointmentDate,
      serviceNames,
      centerName: data.center_Name || data.center_name || centerName(data.center_id) || null,
      zenotiInvoiceId: data.invoice_id || null,
      invoiceNumber: data.invoice_number ? `${data.invoice_number_prefix || ''}${data.invoice_number}` : null,
      visitId: visit ? visit._id : null,
      rebookedFromGroupId: data.rebooked_source_group_id || null,
    });

    // Per Zenoti support: a reschedule creates a brand-new appointment group
    // (this one) and stores the original group id in
    // rebooked_source_group_id. Mark the OLD appointment superseded so it
    // doesn't keep showing as a separate upcoming booking alongside the new
    // one for what's really the same visit. Handled here defensively in
    // case this field only ever shows up on the Created event rather than
    // on the status-change event (see the other handling of this same field
    // in the appointment.status_changed branch above).
    if (data.rebooked_source_group_id) {
      await Appointment.updateOne(
        { brandId, zenotiAppointmentGroupId: data.rebooked_source_group_id },
        { $set: { status: 'rescheduled' } },
      );
    }
  }

  // Per Zenoti support: this generic trigger fires on ANY status change, not
  // just cancellations - so the specific status value has to be inspected
  // rather than assuming every event here means "cancelled". Field names
  // below (status, is_appointment_rescheduled, initial_appointment_start_time,
  // rebooked_source_group_id) are best-guess snake_case matching the rest of
  // this payload's convention - NOT confirmed against a real payload yet.
  // Once one arrives, check RawEvent for eventType "appointment.status_changed"
  // and correct these field names if they differ.
  if (type === 'appointment.status_changed') {
    if (!data.appointment_group_id) {
      console.warn('appointment.status_changed event with no appointment_group_id - could not match to an existing Appointment', JSON.stringify(data).slice(0, 500));
    } else {
      const statusStr = typeof data.status === 'string' ? data.status : null;
      const isCancelled = data.is_cancelled === true || data.cancelled === true || (statusStr && /cancel|no.?show/i.test(statusStr));
      const isRescheduled = data.is_appointment_rescheduled === 1 || data.is_appointment_rescheduled === true;

      const update = { zenotiStatus: statusStr };
      if (isCancelled) {
        update.status = 'cancelled';
        update.cancelledAt = event.event_timestamp ? new Date(event.event_timestamp) : new Date();
      }
      if (isRescheduled) {
        update.wasRescheduled = true;
        if (data.initial_appointment_start_time) update.originalAppointmentDate = new Date(data.initial_appointment_start_time);
      }
      await Appointment.updateOne({ brandId, zenotiAppointmentGroupId: data.appointment_group_id }, { $set: update });

      // Not fully confirmed by Zenoti support whether the rebooking link
      // (rebooked_source_group_id) arrives on this status event or only on
      // the NEW AppointmentGroup.Created event for the rebooked slot (which
      // is also handled below, defensively, in that branch). Handling it
      // here too is harmless if it turns out to only ever appear on Created.
      if (data.rebooked_source_group_id) {
        await Appointment.updateOne(
          { brandId, zenotiAppointmentGroupId: data.rebooked_source_group_id },
          { $set: { status: 'rescheduled' } },
        );
      }
    }
  }

  if (type === 'invoice.closed') {
    const inv = data.invoice || {};
    const guest = inv.guest || {};
    const totalPrice = inv.total_price || {};
    const center = inv.center || {};

    // Safety net: Zenoti's own is_closed flag has been observed to stay
    // false even after a guest has fully paid (transactions present,
    // amount_paid summing to the full invoice total) - likely a Zenoti-side
    // workflow/setting issue (staff/automation not formally "closing" the
    // invoice after checkout), not something we control. Rather than let
    // real, fully-paid revenue sit invisible in the dashboard indefinitely,
    // treat an invoice as effectively closed if it's paid in full, even if
    // Zenoti hasn't flipped is_closed yet. inv.is_closed === true is still
    // honored/preferred whenever Zenoti does send it correctly.
    //
    // This must also cover refunds (inv.is_refund: true), which carry a
    // NEGATIVE total_price/amount_paid. The original check only fired for
    // totalDue > 0, so a refund whose is_closed flag never flips true would
    // sit as 'open' forever and never get netted against the original sale's
    // revenue - comparing amounts by absolute value handles both signs.
    const isRefund = Boolean(inv.is_refund);
    const transactions = Array.isArray(inv.transactions) ? inv.transactions : [];
    const amountPaid = transactions.reduce((sum, t) => sum + (Number(t.amount_paid) || 0), 0);
    const totalDue = Number(totalPrice.sum_total) || 0;
    const isPaidInFull = totalDue !== 0 && Math.abs(amountPaid) >= Math.abs(totalDue) - 0.01; // small tolerance for rounding
    const isEffectivelyClosed = Boolean(inv.is_closed) || isPaidInFull;

    if (!inv.is_closed && isPaidInFull) {
      console.log(`Invoice ${inv.id}: is_closed=false but paid in full (amountPaid=${amountPaid}, totalDue=${totalDue}) - treating as closed anyway.`);
    }

    if (guest.id) {
      await resolveIdentity({
        brandId,
        zenotiGuestId: guest.id,
        email: guest.email,
        phone: guest.mobile_phone,
        name: [guest.first_name, guest.last_name].filter(Boolean).join(' '),
      });
    }

    const customer = guest.id
      ? await Customer.findOne({ brandId, zenotiGuestId: guest.id })
      : null;

    const brand = await Brand.findById(brandId);
    const brandCurrency = (brand && brand.currency) || 'USD';

    // DIAGNOSTIC: AWIN has been recording sale amounts as exactly 1/100th
    // of the real invoice total (e.g. $13.58 -> $0.14, $76.00 -> $0.76).
    // That's happening on the Zapier path, not here, but log the raw
    // Zenoti amount fields on every invoice so the FIRST real invoice that
    // comes through this endpoint tells us definitively whether
    // total_price.sum_total is already a dollar amount (13.58) or a minor
    // unit (1358) for this Zenoti account. Safe to remove once confirmed.
    console.log('ZENOTI AMOUNT DEBUG ->', {
      invoiceId: inv.id,
      sum_total: totalPrice.sum_total,
      sub_total: totalPrice.sub_total,
      tax: totalPrice.tax,
      amountPaidFromTransactions: amountPaid,
      brandCurrency,
    });

    const invoice = await Invoice.findOneAndUpdate(
      { brandId, zenotiInvoiceId: inv.id },
      {
        brandId,
        customerId: customer ? customer._id : null,
        zenotiInvoiceId: inv.id,
        invoiceNumber: inv.invoice_number ? `${inv.invoice_number_prefix || ''}${inv.invoice_number}` : null,
        amount: totalPrice.sum_total,
        tax: Number(totalPrice.tax) || 0,
        isRefund,
        currency: brandCurrency,
        status: isEffectivelyClosed ? 'closed' : 'open',
        closedAt: inv.invoice_date ? new Date(inv.invoice_date) : new Date(),
        centerId: center.id || inv.center_id || null,
        centerName: center.name || centerName(center.id || inv.center_id) || null,
        items: (inv.invoice_items || []).map((item) => ({
          name: item.name,
          price: item.price ? item.price.final : 0,
        })),
      },
      { upsert: true, new: true }
    );

    // Only run conversion processing when the invoice is actually (or
    // effectively) closed - guards against double-counting revenue on
    // invoices that are still genuinely in progress. Refunds are recorded
    // as revenue (negative amount, above) but skip conversion/attribution
    // processing entirely - there's no meaningful "conversion" to attribute
    // or send to ad platforms for a refund, and sending a negative-amount
    // event to those connectors risks corrupting attribution data.
    if (isRefund) {
      console.log(`Invoice ${inv.id} is a refund (amount=${totalPrice.sum_total}) - revenue recorded, skipping conversion/attribution processing.`);
    } else if (isEffectivelyClosed) {
      await processInvoiceConversion({ brandId, invoiceId: invoice._id });
    } else {
      console.log(`Invoice ${inv.id} received with is_closed: false - saved as open, skipping conversion processing until it actually closes.`);
    }
  }
}

module.exports = router;
module.exports.handleEvent = handleEvent;