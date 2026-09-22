const express = require('express');
const crypto = require('crypto');
const RawEvent = require('../db/models/RawEvent');
const Customer = require('../db/models/Customer');
const Appointment = require('../db/models/Appointment');
const Invoice = require('../db/models/Invoice');
const { resolveIdentity } = require('../services/identityResolution');
const { processInvoiceConversion } = require('../services/conversionService');
const router = express.Router();

function verifySignature(req) {
  const secret = process.env.ZENOTI_WEBHOOK_SECRET;
  if (!secret) return true; // allow through in dev if not configured yet

  // CONFIRMED 2026-07-24 against real Zenoti traffic: the header is named
  // "zenoti-webhook-signature" (not "x-zenoti-signature"), and its value is
  // formatted like .NET's BitConverter.ToString() - "sha256 =18-2E-10-EB-..."
  // (uppercase hex byte pairs joined by dashes, not a plain lowercase hex
  // string). Verified byte-for-byte match against a real AppointmentGroup.Created
  // event using this exact parsing.
  const header = req.headers['zenoti-webhook-signature'];
  if (!header) return false;

  const match = header.match(/sha256\s*=\s*([0-9a-f-]+)/i);
  if (!match) return false;
x
  const providedHex = match[1].replace(/-/g, '').toLowerCase();
  const expectedHex = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return providedHex === expectedHex;
}

// POST /webhooks/zenoti?brandId=xxx
router.post('/', async (req, res) => {
  // TEMPORARY DEBUG LOGGING - remove once signature verification is confirmed working.
  // Prints every header name/value and the raw body bytes Zenoti actually sent,
  // so we can see the real signature header name and compare against what
  // verifySignature() expects.
  console.log('ZENOTI TEST -> headers:', JSON.stringify(req.headers));
  console.log('ZENOTI TEST -> rawBody:', req.rawBody ? req.rawBody.toString() : '(no rawBody captured)');

  // Zenoti's "Testing your trigger" button sends an empty POST (no body,
  // no signature) just to confirm the URL is reachable. Treat that as a
  // handshake and accept it without signature verification, instead of
  // requiring a signature that this kind of ping never sends.
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

  // CONFIRMED 2026-07-24: Zenoti wraps every event in an envelope with a real
  // event_type field (e.g. "AppointmentGroup.Created") and an inner `data`
  // object - see detectEventType() below for full detail on this.
  const detectedType = detectEventType(event);

  // 1. Always save the raw event first - this is what enables replay later
  const rawEvent = await RawEvent.create({
    brandId,
    source: 'zenoti',
    eventType: detectedType,
    payload: event,
  });

  // Respond immediately so Zenoti doesn't retry/timeout; process after.
  res.status(202).json({ received: true });

  try {
    await handleEvent(brandId, event);
    rawEvent.processed = true;
    rawEvent.processedAt = new Date();
    await rawEvent.save();
  } catch (err) {
    console.error('Zenoti event processing failed', err);
    // left processed = false so it can be replayed later
  }
});

/**
 * CONFIRMED 2026-07-24 against real Zenoti traffic: every event is wrapped in
 * an envelope like:
 *   { id, event_id, event_schema, event_resource, event_type, event_timestamp, data: {...} }
 * `event_type` IS present after all (PascalCase, dotted - e.g.
 * "AppointmentGroup.Created") - our earlier belief that it was missing came
 * from mistaking Zenoti's dashboard "View Data" preview (which only shows the
 * inner `data` object) for the actual raw wire payload. All the field shapes
 * we confirmed from those previews are correct - they just live one level
 * deeper, under `event.data`, not directly on `event`.
 */
function detectEventType(event) {
  const rawType = (event.event_type || '').toLowerCase();
  if (rawType === 'invoice.closed') return 'invoice.closed';
  if (rawType === 'guest.created') return 'guest.created';
  if (rawType === 'guest.updated') return 'guest.updated';
  if (rawType === 'guest.merged') return 'guest.merged';
  if (rawType === 'appointmentgroup.created') return 'appointment.created';

  // Fallback structural detection, in case event_type is ever missing or a
  // variant we haven't seen yet - checks the shape of event.data.
  const data = event.data || {};
  if (data.invoice) return 'invoice.closed';
  if (data.personal_info) {
    return data.created_date && data.created_date === data.last_updated
      ? 'guest.created'
      : 'guest.updated';
  }
  if (data.appointment_group_id && data.appointments) return 'appointment.created';
  if (data.merged_guest_id) return 'guest.merged';
  return 'unknown';
}

async function handleEvent(brandId, event) {
  const type = detectEventType(event);
  console.log('Handling Zenoti event:', type, 'for brandId:', brandId);
  const data = event.data || {};

  if (type === 'guest.created' || type === 'guest.updated') {
    // Confirmed against real Guest.Created/Guest.Updated payloads.
    const info = data.personal_info || {};
    const name = [info.first_name, info.last_name].filter(Boolean).join(' ');
    const phone = info.mobile_phone && info.mobile_phone.number
      ? `+${info.mobile_phone.phone_code} ${info.mobile_phone.number}`
      : null;
    await resolveIdentity({
      brandId,
      // No website visitorId exists for guests created directly in Zenoti -
      // leave it undefined so resolveIdentity's visit-linking step is skipped
      // (see the guard added in identityResolution.js).
      zenotiGuestId: data.id,
      email: info.email,
      phone,
      name,
    });
  }

  if (type === 'guest.merged') {
    // NOTE: still unconfirmed - no real Guest.Merged sample seen yet. Fix
    // field names once one shows up in Zenoti's webhook logs.
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
    }
  }

if (type === 'appointment.created') {
    // Confirmed against a real AppointmentGroup.Created payload.
    const guest = data.guest || {};

    // Make sure the customer exists, same as a guest event would - some
    // brands may get an appointment booked before/without a separate guest
    // webhook ever firing.
    let customer = null;
    if (guest.id) {
      customer = await resolveIdentity({
        brandId,
        zenotiGuestId: guest.id,
        email: guest.email,
        name: [guest.first_name, guest.last_name].filter(Boolean).join(' '),
      });
    }

    await Appointment.create({
      brandId,
      customerId: customer ? customer._id : null,
      zenotiGuestId: guest.id,
      zenotiAppointmentGroupId: data.appointment_group_id,
      status: 'created',
    });
  }

  if (type === 'invoice.closed') {
    // Confirmed against real Invoice.Closed payloads.
    const inv = data.invoice || {};
    const guest = inv.guest || {};
    const totalPrice = inv.total_price || {};
    // Zenoti's Invoice.Closed payload carries the center as either a nested
    // `center` object ({ id, name }) or a flat `center_id` depending on
    // account/API version - same "confirm against a real payload" caveat as
    // the other fields in this handler applies here; adjust once verified
    // against a live event. Falls back to null (not the brand's configured
    // zenotiCenterId) so we never fabricate a location this invoice didn't
    // actually report.
    const center = inv.center || {};

    // Make sure the customer exists / is up to date, same as a guest event would.
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

    const invoice = await Invoice.findOneAndUpdate(
      { brandId, zenotiInvoiceId: inv.id },
      {
        brandId,
        customerId: customer ? customer._id : null,
        zenotiInvoiceId: inv.id,
        amount: totalPrice.sum_total,
        currency: 'INR', // NOTE: Zenoti sends a numeric currency_id (e.g. 0), not
        // an ISO code - hardcoding INR for now since that's this brand's
        // currency; revisit if this system ever supports multi-currency brands.
        status: inv.is_closed ? 'closed' : 'open',
        closedAt: inv.invoice_date ? new Date(inv.invoice_date) : new Date(),
        centerId: center.id || inv.center_id || null,
        centerName: center.name || null,
      },
      { upsert: true, new: true }
    );

    // This is the moment the whole system has been building toward:
    // invoice paid -> trace back to source -> report conversion.
    //
    // ONLY when it's actually closed. Zenoti's "Invoice.Closed" event can
    // fire with is_closed: false (e.g. a provisional/in-progress invoice
    // state) - previously this ran conversion processing unconditionally,
    // which prematurely credited revenue/sent conversions for sales that
    // weren't finalized yet. Combined with the idempotency claim in
    // conversionService.js, that premature run would have permanently
    // blocked the real close event from ever reprocessing this invoice -
    // so if the final amount changed (tip, discount, added service), that
    // correction would never happen. Skipping here means the invoice record
    // itself still gets upserted with status "open" above (so it's visible,
    // just not yet counted as revenue), and conversion processing waits for
    // a future event where is_closed is actually true.
    if (inv.is_closed) {
      await processInvoiceConversion({ brandId, invoiceId: invoice._id });
    } else {
      console.log(`Invoice ${inv.id} received with is_closed: false - saved as open, skipping conversion processing until it actually closes.`);
    }
  }
}

module.exports = router;
module.exports.handleEvent = handleEvent;