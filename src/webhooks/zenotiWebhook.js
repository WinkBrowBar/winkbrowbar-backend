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

    await Appointment.create({
      brandId,
      customerId: customer ? customer._id : null,
      zenotiGuestId: guest.id,
      zenotiAppointmentGroupId: data.appointment_group_id,
      status: 'created',
    });
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