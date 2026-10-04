const express = require('express');
const Visit = require('../db/models/Visit');
const { requirePublicCaptureToken } = require('../middleware/publicCaptureAuth');
const { resolveIdentity } = require('../services/identityResolution');
const router = express.Router();

// POST /api/attribution/capture
// Called from the Shopify storefront script on every landing page load.
// Protected by requirePublicCaptureToken, NOT the full internal API key -
// this is the one endpoint safe to call from public, browser-visible code.
router.post('/capture', requirePublicCaptureToken, async (req, res) => {
  const {
    brandId, visitorId, utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
    landingPageUrl, referrer, gclid, fbclid, awinClickId,
  } = req.body;

  if (!brandId || !visitorId) {
    return res.status(400).json({ error: 'brandId and visitorId are required' });
  }

  try {
    const visit = await Visit.create({
      brandId, visitorId, utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
      landingPageUrl, referrer, gclid, fbclid, awinClickId,
    });
    res.status(201).json({ success: true, visit: { id: visit._id, capturedAt: visit.capturedAt } });
  } catch (err) {
    console.error('capture error', err);
    res.status(500).json({ error: 'Failed to save attribution' });
  }
});

// POST /api/attribution/identify
// Called from the Shopify storefront right before a visitor is redirected
// to Zenoti's booking widget (which lives on a different domain and never
// sends us back the visitorId). This is the bridge: we already know the
// visitorId and their prior visit(s) here; if we can also get an email or
// phone from them before they leave, resolveIdentity() links that customer
// to their visits NOW. Later, when Zenoti's invoice.closed webhook arrives
// with that same email/phone, it resolves to the SAME customer record -
// which already has the right visit(s) attached - no changes needed on
// the webhook side at all.
//
// Same auth model as /capture: a public, per-brand token, safe for
// browser-visible code, scoped to this one action only.
router.post('/identify', requirePublicCaptureToken, async (req, res) => {
  const { brandId, visitorId, email, phone, name } = req.body;

  if (!brandId || !visitorId || (!email && !phone)) {
    return res.status(400).json({ error: 'brandId, visitorId, and at least one of email/phone are required' });
  }

  try {
    const customer = await resolveIdentity({ brandId, visitorId, email, phone, name });
    res.status(201).json({ success: true, customerId: customer._id });
  } catch (err) {
    console.error('identify error', err);
    res.status(500).json({ error: 'Failed to link visitor to customer' });
  }
});

module.exports = router;