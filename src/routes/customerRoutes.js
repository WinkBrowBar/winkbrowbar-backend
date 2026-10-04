const express = require('express');
const Customer = require('../db/models/Customer');
const { resolveIdentity } = require('../services/identityResolution');
const router = express.Router();

// POST /api/customers - called when a visitor books/submits their details
router.post('/', async (req, res) => {
  const { brandId, visitorId, email, phone, name } = req.body;
  if (!brandId || !visitorId || (!email && !phone)) {
    return res.status(400).json({ error: 'brandId, visitorId, and at least one of email/phone are required' });
  }
  try {
    const customer = await resolveIdentity({ brandId, visitorId, email, phone, name });
    res.status(201).json({ success: true, customer });
  } catch (err) {
    console.error('customer create error', err);
    res.status(500).json({ error: 'Failed to create/link customer' });
  }
});

// GET /api/customers/:id - includes first/latest touch and lifetime revenue
router.get('/:id', async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id)
      .populate('firstTouchVisitId')
      .populate('latestTouchVisitId');
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json({ customer });
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// PATCH /api/customers/:id
router.patch('/:id', async (req, res) => {
  const { email, phone, name } = req.body;
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    if (email) customer.email = email;
    if (phone) customer.phone = phone;
    if (name) customer.name = name;
    await customer.save();
    res.json({ success: true, customer });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

module.exports = router;
