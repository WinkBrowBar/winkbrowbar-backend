const Brand = require('../db/models/Brand');
const Visit = require('../db/models/Visit');

/**
 * Finds the visit that should get credit for a customer's conversion,
 * based on the brand's configured attribution model.
 * Default: last_touch. Every visit is still stored regardless of which
 * model is used, so switching models later is a query change, not a
 * data migration.
 *
 * requireClickId (default true) restricts matches to visits that carry an
 * ad-platform click id (gclid/fbclid/awinClickId) - this is what the ad-send
 * path needs, since it has to hand a real click id back to Meta/Google/AWIN.
 * Pass false for sources like Klaviyo that only need UTM/campaign context,
 * not a click id to report against - otherwise every Klaviyo (or any other
 * non-ad-click) conversion is guaranteed to find no visit at all, and its
 * campaign will always read "(no campaign)" regardless of email tagging.
 *
 * Only visits within the brand's attributionWindowDays (default 30) of the
 * purchase are eligible - without this, a months-old click would stay
 * matchable forever, since a returning direct visit never creates a new
 * Visit record to compete with it. A purchase outside the window falls
 * through to the organic/direct fallback in conversionService.js instead,
 * same as if there had never been a tracked visit at all.
 */
async function pickAttributedVisit({ brandId, customerId, beforeTimestamp, requireClickId = true }) {
  const brand = await Brand.findById(brandId);
  const model = (brand && brand.attributionModel) || 'last_touch';
  const windowDays = (brand && brand.attributionWindowDays) || 30;

  const sortDirection = model === 'first_touch' ? 1 : -1; // -1 = most recent first (last_touch)

  const until = beforeTimestamp || new Date();
  const windowStart = new Date(until.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const query = {
    brandId,
    customerId,
    capturedAt: { $gte: windowStart, $lte: until },
  };
  if (requireClickId) {
    query.$or = [{ gclid: { $ne: null } }, { fbclid: { $ne: null } }, { awinClickId: { $ne: null } }];
  }

  const visit = await Visit.findOne(query).sort({ capturedAt: sortDirection });

  return { visit: visit || null, modelUsed: model };
}

/**
 * Maps a visit's click id to the platform it belongs to.
 */
function platformFromVisit(visit) {
  if (!visit) return null;
  if (visit.fbclid) return { platform: 'meta', clickId: visit.fbclid };
  if (visit.gclid) return { platform: 'google', clickId: visit.gclid };
  if (visit.awinClickId) return { platform: 'awin', clickId: visit.awinClickId };
  return null;
}

module.exports = { pickAttributedVisit, platformFromVisit };