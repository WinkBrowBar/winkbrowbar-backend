const jwt = require('jsonwebtoken');

/**
 * Verifies a Bearer JWT and attaches the decoded payload to req.user.
 * Used for the dashboard and any route where a real logged-in human
 * (not an admin tool or the Shopify snippet) needs access.
 */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization: Bearer <token> header' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { userId, brandId, role, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Use after requireAuth. Restricts a route to specific roles, e.g.
 * requireRole('admin') for user-management endpoints.
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions for this action' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
