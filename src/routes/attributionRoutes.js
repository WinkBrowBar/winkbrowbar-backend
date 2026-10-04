const express = require('express');
const Visit = require('../db/models/Visit');
const router = express.Router();

// GET /api/attribution/lookup?brandId=&customerId=
// Internal only - requires the full API key, mounted separately in server.js.
router.get('/lookup', async (req, res) => {
  const { brandId, customerId } = req.query;
  if (!brandId || !customerId) return res.status(400).json({ error: 'brandId and customerId are required' });
  try {
    const visits = await Visit.find({ brandId, customerId }).sort({ capturedAt: -1 });
    res.json({ visits });
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

module.exports = router;
