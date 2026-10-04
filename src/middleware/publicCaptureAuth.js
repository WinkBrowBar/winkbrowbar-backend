const Brand = require('../db/models/Brand');

/**
 * Used ONLY on POST /api/attribution/capture. This is deliberately separate
 * from requireApiKey (auth.js) - it never sees INTERNAL_API_KEY, so that
 * secret never has to be embedded in a public, browser-visible script.
 *
 * The token is scoped per-brand and can only ever be used to create a Visit
 * via this one endpoint - it grants no read access and no access to any
 * other route.
 */
async function requirePublicCaptureToken(req, res, next) {
  const token = req.headers['x-capture-token'];
  const { brandId } = req.body;

  if (!token || !brandId) {
    return res.status(401).json({ error: 'Missing capture token or brandId' });
  }

  try {
    const brand = await Brand.findOne({ _id: brandId, publicCaptureToken: token, isActive: true });
    if (!brand) {
      return res.status(401).json({ error: 'Invalid capture token for this brand' });
    }
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid capture token' });
  }
}

module.exports = { requirePublicCaptureToken };
