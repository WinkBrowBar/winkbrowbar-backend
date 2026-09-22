const Customer = require('../db/models/Customer');
const Visit = require('../db/models/Visit');

/**
 * Given an email/phone captured at booking time, find or create the
 * Customer record, then link the current visitor's prior visit(s) to it.
 * Also maintains firstTouchVisitId (set once, never overwritten) and
 * latestTouchVisitId (always refreshed) directly on the customer record.
 */
async function resolveIdentity({ brandId, visitorId, email, phone, name, zenotiGuestId }) {
  // 1. Try to find an existing customer by email, phone, or zenotiGuestId
  let customer = null;
  if (email || phone || zenotiGuestId) {
    customer = await Customer.findOne({
      brandId,
      $or: [
        ...(email ? [{ email }] : []),
        ...(phone ? [{ phone }] : []),
        ...(zenotiGuestId ? [{ zenotiGuestId }] : []),
      ],
    });
  }

  // 2. Create if not found
  if (!customer) {
    customer = await Customer.create({ brandId, email, phone, name, zenotiGuestId });
  } else {
    if (email) customer.email = email;
    if (phone) customer.phone = phone;
    if (name) customer.name = name;
    // zenotiGuestId should only ever be set once we have it - don't blank it
    // out on a later update that happens not to include it.
    if (zenotiGuestId) customer.zenotiGuestId = zenotiGuestId;
    await customer.save();
  }

  // 3. Link this session's visit(s) - any visit with this visitorId not yet linked.
  // IMPORTANT: only do this when we actually have a visitorId. Zenoti-originated
  // events (guest created/updated, invoice closed) have no website visitorId at
  // all - if we let visitorId be undefined here, Mongoose drops it from the
  // query and `Visit.find({ brandId, visitorId: undefined, customerId: null })`
  // silently becomes `Visit.find({ brandId, customerId: null })`, which would
  // grab every unlinked visit for the ENTIRE brand and wrongly attach them all
  // to whichever customer happens to trigger this next. Skip entirely instead.
  if (visitorId) {
    const unlinkedVisits = await Visit.find({
      brandId,
      visitorId,
      customerId: null,
    }).sort({ capturedAt: 1 }); // oldest first, so first-touch logic below is correct

    if (unlinkedVisits.length > 0) {
      await Visit.updateMany(
        { _id: { $in: unlinkedVisits.map((v) => v._id) } },
        { $set: { customerId: customer._id } }
      );

      // Never ever replace the first touch - only set it if it's still empty
      if (!customer.firstTouchVisitId) {
        customer.firstTouchVisitId = unlinkedVisits[0]._id;
      }
      // Latest touch always refreshes to the most recent visit just linked
      const mostRecent = unlinkedVisits[unlinkedVisits.length - 1];
      customer.latestTouchVisitId = mostRecent._id;
      await customer.save();
    }
  }

  return customer;
}

module.exports = { resolveIdentity };