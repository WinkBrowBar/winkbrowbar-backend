const express = require('express');
const { requireRole } = require('../middleware/requireAuth');
const engine = require('../inventory/engine');
const router = express.Router();

// Wink retail stock: Zenoti studios -> Shopify studio locations. Admin-only (mounted behind
// requireAuth in server.js). Never writes to Zenoti; the 194 Court warehouses are never written.
router.use(requireRole('admin'));

// Turns a thrown error into a JSON reply (and an "error" entry in the Logs tab for real failures).
const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    const msg = e.response ? JSON.stringify(e.response.data) : e.message;
    if (!e.status || e.status >= 500) await engine.logActivity({ type: 'error', who: 'system', summary: `${req.method} ${req.originalUrl.split('?')[0]} failed: ${msg}`.slice(0, 500) });
    res.status(e.status || 500).json({ error: msg });
  }
};
const who = (req) => req.user?.email || 'dashboard';

router.get('/data', wrap((req) => engine.getData({ refresh: req.query.refresh === '1' })));
router.post('/links', wrap((req) => engine.saveLinks(req.body?.links, req.body?.ignore, who(req))));
router.post('/preview', wrap((req) => engine.makePlan({ who: who(req), record: true })));
router.post('/apply', wrap((req) => engine.applyPlan({ force: !!req.body?.force, who: who(req) })));
router.get('/logs', wrap((req) => engine.getLogs(Math.min(Number(req.query.limit) || 100, 500))));

module.exports = router;