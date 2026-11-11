// engine.js - logic behind the dashboard's Inventory page: live Zenoti + Shopify data, saved
// links (MongoDB), preview and apply. Never writes to Zenoti; writes to Shopify only in applyPlan().
const config = require('./config.json');
const overrides = require('./overrides.json');
const clients = require('./clients');
const { buildPlan, summarize } = require('./plan');
const InventoryLinks = require('../db/models/InventoryLinks');
const InventoryActivity = require('../db/models/InventoryActivity');

const centers = Object.keys(config.centers);
const CACHE_MS = 30 * 1000;
let cache = null; // { at, live }

// ---------------------------------------------------------------- activity log (Logs tab)
async function logActivity(entry) {
  try { await InventoryActivity.create(entry); } catch (e) { console.error('[inventory] could not write activity log:', e.message); } // logging must never break a sync
}
async function getLogs(limit = 100) {
  const docs = await InventoryActivity.find().sort({ createdAt: -1 }).limit(limit).lean();
  const last = await InventoryActivity.findOne({ type: 'apply' }).sort({ createdAt: -1 }).lean();
  return {
    entries: docs.map((d) => ({ at: d.createdAt, type: d.type, who: d.who, summary: d.summary, ...(d.data || {}) })),
    lastApply: last && { at: last.createdAt, written: last.data?.written, failed: last.data?.failed, who: last.who },
  };
}

// ---------------------------------------------------------------- live data
async function fetchLive() {
  const zByCenter = {};
  for (const [c, id] of Object.entries(config.centers)) zByCenter[c] = new Map((await clients.zenotiRetailStock(id)).map((p) => [p.code, p]));
  const names = new Map();
  Object.values(zByCenter).forEach((m) => m.forEach((p, code) => names.set(code, p.name)));
  const zenoti = [...names].map(([code, name]) => ({
    code, name, excluded: config.excludeCodes.includes(code),
    stock: Object.fromEntries(centers.map((c) => [c, zByCenter[c].has(code) ? zByCenter[c].get(code).quantity : null])),
  })).sort((a, b) => Number(a.code) - Number(b.code));

  const all = (await clients.shopifyAllVariants()).filter((v) => config.allowedShopifyStatuses.includes(v.status));
  const bundles = await clients.shopifyBundleVariantIds();
  const itemIds = all.map((v) => v.inventory_item_id);
  const locs = { ...config.locations, ...config.centralLocations }; // central warehouses: shown for reference, never written
  const levels = {};
  for (const [k, id] of Object.entries(locs)) levels[k] = await clients.shopifyLevels(id, itemIds);
  const shopify = all.map((v) => ({
    variant_id: v.variant_id, inventory_item_id: v.inventory_item_id, product: v.product, variant: v.variant, sku: v.sku, status: v.status,
    isBundle: bundles.has(Number(v.variant_id)), tracked: v.inventory_management === 'shopify',
    stock: Object.fromEntries(Object.keys(locs).map((k) => [k, levels[k].has(v.inventory_item_id) ? levels[k].get(v.inventory_item_id) : null])),
  }));
  return { zenoti, shopify };
}

// Reused for 30s so quick clicks don't hammer Zenoti's rate limit; refresh=true forces a new fetch.
async function getLive({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache;
  cache = { at: Date.now(), live: await fetchLive() };
  return cache;
}

// ---------------------------------------------------------------- suggestions + saved links
// Suggested links by name: overrides first, then exact name tokens.
function suggest(zenoti, shopify) {
  const out = {}; const used = new Set();
  const byCode = new Map(zenoti.map((z) => [z.code, z]));
  for (const [code, title] of Object.entries(overrides)) {
    if (code.startsWith('_') || !byCode.has(code)) continue;
    shopify.filter((s) => clients.tokens(s.product) === clients.tokens(title)).forEach((s) => { (out[code] = out[code] || []).push(s.variant_id); used.add(s.variant_id); });
  }
  const byTok = new Map();
  zenoti.forEach((z) => { const k = clients.tokens(z.name); byTok.set(k, [...(byTok.get(k) || []), z]); });
  for (const s of shopify) {
    if (used.has(s.variant_id)) continue;
    const hit = byTok.get(clients.tokens(`${s.product} ${s.variant}`));
    if (hit && hit.length === 1) (out[hit[0].code] = out[hit[0].code] || []).push(s.variant_id);
  }
  return out;
}

async function readSaved() {
  const d = await InventoryLinks.findOne({ key: 'wink' }).lean();
  return d ? { savedAt: d.updatedAt, links: d.links || {}, ignore: d.ignore || [] } : null;
}

function rowsFromLinks(saved, live) {
  const zBy = new Map(live.zenoti.map((z) => [z.code, z])); const sBy = new Map(live.shopify.map((s) => [String(s.variant_id), s]));
  const rows = [];
  for (const [code, ids] of Object.entries(saved.links)) {
    if (saved.ignore.includes(code) || !zBy.has(code)) continue;
    for (const id of ids) { const s = sBy.get(String(id)); if (s) rows.push({ code, zenotiName: zBy.get(code).name, product: s.product, variant: s.variant, variant_id: s.variant_id, inventory_item_id: s.inventory_item_id }); }
  }
  return rows.sort((a, b) => Number(a.code) - Number(b.code));
}

// Everything the screen needs in one call.
async function getData({ refresh = false } = {}) {
  const { at, live } = await getLive({ refresh });
  return { ...live, saved: await readSaved(), suggested: suggest(live.zenoti, live.shopify), defaultIgnore: config.excludeCodes, centers, fetchedAt: new Date(at).toISOString() };
}

// links: { zenotiCode: [variantId, ...] }, ignore: [zenotiCode, ...]
async function saveLinks(links, ignore, who = 'dashboard') {
  const clean = {};
  for (const [code, ids] of Object.entries(links || {})) if (Array.isArray(ids) && ids.length) clean[String(code)] = ids.map(String);
  const ign = (ignore || []).map(String);
  await InventoryLinks.findOneAndUpdate({ key: 'wink' }, { key: 'wink', links: clean, ignore: ign, savedBy: who }, { upsert: true, new: true, setDefaultsOnInsert: true });
  const { live } = await getLive();
  const rows = rowsFromLinks({ links: clean, ignore: ign }, live);
  await logActivity({ type: 'links_saved', who, summary: `Saved ${rows.length} product link(s), ${ign.length} marked "don't sync"`, data: { rows: rows.length, ignored: ign.length } });
  return { ok: true, rows: rows.length };
}

// ---------------------------------------------------------------- plan + apply
async function makePlan({ who = 'dashboard', record = false } = {}) {
  const saved = await readSaved(); if (!saved) throw Object.assign(new Error('Save your links first.'), { status: 400 });
  const { live } = await getLive({ refresh: true }); // always fresh numbers before a preview/apply
  const rows = rowsFromLinks(saved, live);
  const zenotiByCenter = {}; const levelsByLoc = {};
  centers.forEach((c) => {
    zenotiByCenter[c] = new Map(live.zenoti.filter((z) => z.stock[c] !== null).map((z) => [z.code, z.stock[c]]));
    levelsByLoc[c] = new Map(live.shopify.filter((s) => s.stock[c] !== null).map((s) => [s.inventory_item_id, s.stock[c]]));
  });
  const bundleIds = new Set(live.shopify.filter((s) => s.isBundle).map((s) => Number(s.variant_id)));
  const plan = buildPlan(rows, zenotiByCenter, levelsByLoc, bundleIds, config);
  const summary = summarize(plan);
  if (record) await logActivity({ type: 'preview', who, summary: `Preview: ${summary.changes.length} change(s) - ${summary.up} up, ${summary.down} down (${summary.toZero} to 0), ${summary.connects} to add, ${summary.skipped} skipped`, data: { changes: summary.changes.length } });
  return { plan, summary };
}

let applying = false;
async function applyPlan({ force = false, who = 'dashboard' } = {}) {
  if (applying) throw Object.assign(new Error('An apply is already running.'), { status: 409 });
  applying = true;
  try {
    const { summary: s } = await makePlan();
    if (!s.changes.length) return { written: 0, failed: 0, results: [] }; // already in sync - nothing to write or log
    const block = async (msg) => { await logActivity({ type: 'apply_blocked', who, summary: msg }); return Object.assign(new Error(msg), { status: 400 }); };
    if (s.changes.length > config.maxWritesPerRun && !force) throw await block(`Refusing: ${s.changes.length} writes exceeds maxWritesPerRun (${config.maxWritesPerRun}). Tick "Override safety limits" if intended.`);
    if (s.considered && s.toZero / s.considered > config.maxZeroedFractionWithoutForce && !force) throw await block(`Refusing: ${s.toZero} of ${s.considered} would drop to 0 (more than ${config.maxZeroedFractionWithoutForce * 100}%). Check Zenoti stock accuracy, or tick "Override safety limits".`);
    const results = [];
    for (const p of s.changes) {
      try {
        if (p.action === 'connect+set') await clients.shopifyConnect(p.locationId, p.inventory_item_id);
        const lvl = await clients.shopifySetLevel(p.locationId, p.inventory_item_id, p.target);
        results.push({ code: p.code, center: p.center, product: p.product, variant: p.variant, before: p.now, after: lvl.available, ok: true });
      } catch (e) {
        results.push({ code: p.code, center: p.center, product: p.product, variant: p.variant, before: p.now, attempted: p.target, ok: false, error: e.response ? JSON.stringify(e.response.data) : e.message });
      }
    }
    cache = null; // numbers changed - next load must be fresh
    const failed = results.filter((r) => !r.ok).length;
    const written = results.length - failed;
    await logActivity({ type: 'apply', who, summary: `Applied: ${written} written to Shopify, ${failed} failed`, data: { written, failed, forced: !!force, changes: results } });
    return { written, failed, results: results.filter((r) => !r.ok) };
  } finally { applying = false; }
}

module.exports = { centers, getData, saveLinks, makePlan, applyPlan, getLogs, logActivity, suggest, rowsFromLinks };