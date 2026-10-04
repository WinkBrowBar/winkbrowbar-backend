const express = require('express');
const Conversion = require('../db/models/Conversion');
const RawEvent = require('../db/models/RawEvent');
const router = express.Router();

// GET /api/conversions?brandId= - view conversion log
router.get('/', async (req, res) => {
  const { brandId } = req.query;
  if (!brandId) return res.status(400).json({ error: 'brandId required' });
  try {
    const conversions = await Conversion.find({ brandId }).sort({ createdAt: -1 }).limit(100);
    res.json({ conversions });
  } catch (err) {
    res.status(500).json({ error: 'Query failed' });
  }
});

// POST /api/conversions/replay/:rawEventId - reprocess a stored raw event
router.post('/replay/:rawEventId', async (req, res) => {
  try {
    const event = await RawEvent.findById(req.params.rawEventId);
    if (!event) return res.status(404).json({ error: 'Raw event not found' });

    const { handleEvent } = require('../webhooks/zenotiWebhook');
    await handleEvent(String(event.brandId), event.payload);
    event.processed = true;
    event.processedAt = new Date();
    await event.save();

    res.json({ success: true, replayed: true });
  } catch (err) {
    console.error('replay error', err);
    res.status(500).json({ error: 'Replay failed' });
  }
});

module.exports = router;
