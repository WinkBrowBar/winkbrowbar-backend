const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../db/models/User');
const { requireAuth, requireRole } = require('../middleware/requireAuth');
const router = express.Router();

// POST /api/auth/login
// Public - anyone with valid credentials can log in.
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase(), isActive: true });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user._id, brandId: user.brandId, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: { id: user._id, email: user.email, name: user.name, role: user.role, brandId: user.brandId },
    });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/users - create a new user (admin or viewer)
// Two ways in: the internal API key (for bootstrapping the very first admin
// account, before any user/JWT exists yet), or an existing admin's JWT (for
// day-to-day account creation once the dashboard is up and running).
function requireInternalKeyOrAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === process.env.INTERNAL_API_KEY) return next();

  requireAuth(req, res, (err) => {
    if (err) return;
    requireRole('admin')(req, res, next);
  });
}

router.post('/users', requireInternalKeyOrAdmin, async (req, res) => {
  const { brandId, email, password, name, role } = req.body;
  if (!brandId || !email || !password) {
    return res.status(400).json({ error: 'brandId, email, and password are required' });
  }
  if (role && !['admin', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin or viewer' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      brandId,
      email: email.toLowerCase(),
      passwordHash,
      name,
      role: role || 'viewer',
    });
    res.status(201).json({
      success: true,
      user: { id: user._id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'A user with this email already exists for this brand' });
    }
    console.error('create user error', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// GET /api/auth/users - list users for a brand (admin only, via JWT)
router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const users = await User.find({ brandId: req.user.brandId }).select('-passwordHash');
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// DELETE /api/auth/users/:id - deactivate a user (admin only, via JWT)
router.delete('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, brandId: req.user.brandId },
      { isActive: false },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

module.exports = router;
