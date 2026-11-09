// plan.js - pure logic (no network, no database): turns linked products + Zenoti studio stock +
// current Shopify levels into the list of changes to make.

// One studio's Zenoti quantity -> what Shopify should show at that studio's location.
// 'floor-at-zero' (default): negative Zenoti stock shows as 0. 'allow-negative': copied as is.
function studioTarget(qty, rule) {
  if (!Number.isFinite(qty)) return null;
  return rule === 'allow-negative' ? Math.floor(qty) : Math.max(0, Math.floor(qty));
}

// One plan entry per (linked variant x studio).
// zenotiByCenter: { CH: Map(code->qty), ... }   levelsByLoc: { CH: Map(item->available), ... }
function buildPlan(rows, zenotiByCenter, levelsByLoc, bundleVariantIds, cfg) {
  const plan = [];
  for (const r of rows) {
    for (const [center, map] of Object.entries(zenotiByCenter)) {
      const base = { code: r.code, center, product: r.product, variant: r.variant, inventory_item_id: r.inventory_item_id, locationId: cfg.locations[center] };
      if (cfg.skipBundles && bundleVariantIds.has(Number(r.variant_id))) { plan.push({ ...base, zenotiQty: null, target: null, now: null, delta: null, action: 'skip', note: 'bundle - Shopify derives its stock' }); continue; }
      if (!map.has(r.code)) { plan.push({ ...base, zenotiQty: null, target: null, now: null, delta: null, action: 'skip', note: 'not in Zenoti stock' }); continue; }
      const qty = map.get(r.code);
      const target = studioTarget(qty, cfg.negativeStock);
      const levels = levelsByLoc[center];
      const stocked = levels.has(r.inventory_item_id);
      if (!stocked && !cfg.connectMissingLocations) { plan.push({ ...base, zenotiQty: qty, target: null, now: null, delta: null, action: 'skip', note: 'not stocked at this Shopify location' }); continue; }
      const now = stocked ? levels.get(r.inventory_item_id) : 0;
      const delta = target - now;
      const action = !stocked ? 'connect+set' : delta === 0 ? 'same' : 'set';
      plan.push({ ...base, zenotiQty: qty, target, now, delta, action, note: stocked ? '' : 'will be added to this location' });
    }
  }
  return plan;
}

function summarize(plan) {
  const active = plan.filter((p) => p.action !== 'skip');
  const changes = active.filter((p) => p.action !== 'same');
  return {
    considered: active.length,
    unchanged: active.length - changes.length,
    up: changes.filter((p) => p.delta > 0).length,
    down: changes.filter((p) => p.delta < 0).length,
    toZero: changes.filter((p) => p.target === 0 && p.now > 0).length,
    connects: changes.filter((p) => p.action === 'connect+set').length,
    skipped: plan.length - active.length,
    changes,
  };
}

module.exports = { studioTarget, buildPlan, summarize };