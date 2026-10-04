const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const Brand = require('../db/models/Brand');
const router = express.Router();

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY; // Client ID from the Shopify app
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET; // Client Secret from the Shopify app
const SCOPES = 'read_customers,read_orders';
const APP_URL = process.env.APP_URL; // e.g. https://your-real-backend.com

/**
 * Verifies that a request genuinely came from Shopify by checking its HMAC
 * signature against our app secret. Shopify docs: this must be checked on
 * every request during the OAuth flow before trusting any query params.
 */
function verifyHmac(query) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join('&');
  const generatedHash = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(message)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmac));
}

// GET /shopify/install?shop=winkbrow-bar.myshopify.com
// Step 1: Shopify (or you manually) hits this to kick off the OAuth flow.
router.get('/install', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${APP_URL}/shopify/callback`;
  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  // In production, store `state` (e.g. in a short-lived cookie or cache) and
  // verify it matches on callback, to prevent CSRF. Kept simple here for Phase 1.
  res.redirect(installUrl);
});

// GET /shopify/callback?code=...&shop=...&hmac=...&state=...&timestamp=...
// Step 2: Shopify redirects here after the merchant approves the app.
// This is the piece the static placeholder page could never do - it
// exchanges the temporary code for a real, permanent Admin API access token.
router.get('/callback', async (req, res) => {
  const { shop, code, hmac } = req.query;

  if (!shop || !code) {
    return res.status(400).send('Missing required parameters');
  }

  if (!verifyHmac(req.query)) {
    return res.status(401).send('HMAC validation failed - request may not be from Shopify');
  }

  try {
    // Exchange the temporary authorization code for a permanent access token
    const tokenResponse = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    });

    const { access_token, scope } = tokenResponse.data;

    // Save the token against the matching brand. If no brand exists yet for
    // this shop, create one so the token isn't lost.
    let brand = await Brand.findOne({ shopifyStoreUrl: shop });
    if (!brand) {
      brand = await Brand.create({
        name: shop.replace('.myshopify.com', ''),
        slug: shop.replace('.myshopify.com', ''),
        shopifyStoreUrl: shop,
      });
    }
    brand.shopifyAccessToken = access_token;
    brand.shopifyScopes = scope;
    await brand.save();

    res.send(
      `Shopify connected successfully for ${shop}. You can close this tab. ` +
      `Brand ID: ${brand._id}`
    );
  } catch (err) {
    console.error('Shopify OAuth callback failed', err.response ? err.response.data : err.message);
    res.status(500).send('Failed to complete Shopify installation - check server logs');
  }
});

module.exports = router;
