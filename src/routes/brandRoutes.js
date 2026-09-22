const express = require('express');
const crypto = require('crypto');
const Brand = require('../db/models/Brand');
const MarketingPlatform = require('../db/models/MarketingPlatform');
const router = express.Router();

// POST /api/brands - onboarding a new brand is just this call
router.post('/', async (req, res) => {
  const { name, slug, shopifyStoreUrl, zenotiCenterId, attributionModel, currency } = req.body;
  try {
    const brand = await Brand.create({
      name, slug, shopifyStoreUrl, zenotiCenterId,
      attributionModel: attributionModel || 'last_touch',
      currency: currency || 'USD',
    });
    res.status(201).json({ success: true, brand });
  } catch (err) {
    console.error('brand create error', err);
    res.status(500).json({ error: 'Failed to create brand' });
  }
});

// GET /api/brands - list all brands (id, name, slug, currency, etc.) so
// brandId can be looked up over the API instead of needing shell/script
// access to the database.
router.get('/', async (req, res) => {
  try {
    const brands = await Brand.find({}).sort({ createdAt: -1 });
    res.json({ success: true, brands });
  } catch (err) {
    console.error('brand list error', err);
    res.status(500).json({ error: 'Failed to list brands' });
  }
});

// PATCH /api/brands/:id - update a brand's own settings, e.g. to fix
// currency on an existing brand (like Wink Brow Bar, previously defaulting
// to INR) without needing direct database access.
router.patch('/:id', async (req, res) => {
  const { name, shopifyStoreUrl, zenotiCenterId, attributionModel, attributionWindowDays, currency } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (shopifyStoreUrl !== undefined) updates.shopifyStoreUrl = shopifyStoreUrl;
  if (zenotiCenterId !== undefined) updates.zenotiCenterId = zenotiCenterId;
  if (attributionModel !== undefined) updates.attributionModel = attributionModel;
  if (attributionWindowDays !== undefined) updates.attributionWindowDays = attributionWindowDays;
  if (currency !== undefined) updates.currency = currency;

  try {
    const brand = await Brand.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json({ success: true, brand });
  } catch (err) {
    console.error('brand update error', err);
    res.status(500).json({ error: 'Failed to update brand' });
  }
});

// GET /api/brands/by-shop/:shopifyStoreUrl - used by the Shopify OAuth callback
router.get('/by-shop/:shopifyStoreUrl', async (req, res) => {
  try {
    const brand = await Brand.findOne({ shopifyStoreUrl: req.params.shopifyStoreUrl });
    if (!brand) return res.status(404).json({ error: 'No brand found for this shop' });
    res.json({ brand });
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// POST /api/brands/:id/platforms - attach platform credentials to a brand
router.post('/:id/platforms', async (req, res) => {
  const { id } = req.params;
  const { platform, credentials } = req.body;
  if (!['meta', 'google', 'awin', 'klaviyo'].includes(platform)) {
    return res.status(400).json({ error: 'Unknown platform' });
  }
  try {
    const record = await MarketingPlatform.findOneAndUpdate(
      { brandId: id, platform },
      { credentials, isActive: true },
      { upsert: true, new: true }
    );
    res.status(201).json({ success: true, platform: record });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save platform credentials' });
  }
});

// POST /api/brands/:id/generate-capture-token
// Generates (or rotates) the low-privilege token used by the public
// Shopify tracking snippet. Safe to re-run any time to rotate it.
router.post('/:id/generate-capture-token', async (req, res) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const brand = await Brand.findByIdAndUpdate(
      req.params.id,
      { publicCaptureToken: token },
      { new: true }
    );
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json({ success: true, publicCaptureToken: token });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate capture token' });
  }
});

module.exports = router;