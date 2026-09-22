require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { connectDB } = require('./db/connection');
const { requireApiKey } = require('./middleware/auth');
const attributionRoutes = require('./routes/attributionRoutes');
const captureRoutes = require('./routes/captureRoutes');
const customerRoutes = require('./routes/customerRoutes');
const brandRoutes = require('./routes/brandRoutes');
const conversionRoutes = require('./routes/conversionRoutes');
const shopifyOAuth = require('./routes/shopifyOAuth');
const zenotiWebhook = require('./webhooks/zenotiWebhook');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(rateLimit({ windowMs: 60 * 1000, max: 300 }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Shopify OAuth flow - public, verified via HMAC signature (not API key),
// since Shopify itself calls these during install, not our own frontend.
app.use('/shopify', shopifyOAuth);

// Public webhook endpoint (Zenoti calls this directly - verified via signature, not API key)
app.use('/webhooks/zenoti', zenotiWebhook);

// Public capture endpoint - protected by its own per-brand token, safe to
// call from the Shopify storefront script. Deliberately NOT behind requireApiKey.
app.use('/api/attribution', captureRoutes);

// Internal API - requires x-api-key header (used by admin tools, never the browser)
app.use('/api/attribution', requireApiKey, attributionRoutes);
app.use('/api/customers', requireApiKey, customerRoutes);
app.use('/api/brands', requireApiKey, brandRoutes);
app.use('/api/conversions', requireApiKey, conversionRoutes);

const PORT = process.env.PORT || 4000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Attribution system running on port ${PORT}`);
  });
});
