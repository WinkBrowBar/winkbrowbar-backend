const express = require('express');
const mongoose = require('mongoose');
const Conversion = require('../db/models/Conversion');
const Invoice = require('../db/models/Invoice');
const Customer = require('../db/models/Customer');
const Visit = require('../db/models/Visit');
const AdSpend = require('../db/models/AdSpend');
const { requireRole } = require('../middleware/requireAuth');
const { centerName, CENTER_NAMES } = require('../utils/centerNames');
const router = express.Router();

router.use(requireRole('admin', 'viewer'));

// Builds a $match-compatible clause that scopes a query to a single center,
// given a human-readable location name (what's stored in Invoice.centerName).
// Only Invoice (and anything joined to it) actually carries a center, so
// this is only ever applied to invoice-rooted or invoice-joined pipelines -
// Customer/Visit/AdSpend have no location concept and stay brand-wide.
// `location` of undefined/''/'all' means "every location" -> no filter.
function centerMatchClause(location, field = 'centerName') {
  if (!location || location === 'all') return {};
  if (location === '(unknown location)') {
    return { $or: [{ [field]: null }, { [field]: { $exists: false } }] };
  }
  return { [field]: location };
}

// Groups a date range into day/week/month buckets for trend charts,
// depending on how wide the range is - a year of daily points would be
// unreadable, and a week of monthly points would be pointless.
function pickGranularity(windowDays) {
  if (windowDays == null || windowDays > 180) return { granularity: 'month', format: '%Y-%m' };
  if (windowDays > 45) return { granularity: 'week', format: '%G-W%V' };
  return { granularity: 'day', format: '%Y-%m-%d' };
}

function resolveRange(query) {
  const { days, startDate, endDate } = query;

  if (startDate || endDate) {
    const since = startDate ? new Date(startDate) : new Date(0);
    since.setHours(0, 0, 0, 0);
    const until = endDate ? new Date(endDate) : new Date();
    until.setHours(23, 59, 59, 999);
    return { since, until, windowDays: Math.max(1, Math.round((until - since) / 86400000)), custom: true };
  }

  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - (Number(days) || 30));
  return { since, until, windowDays: Number(days) || 30, custom: false };
}

// Same as resolveRange, but when no explicit startDate/endDate/days is given,
// defaults to "today through the far future" instead of "last 30 days through
// now". Used by /customers and /campaigns so those views only surface
// current + upcoming activity, not historical data. An explicit startDate/
// endDate still works normally if someone wants to look at the past.
function resolveForwardRange(query) {
  const { startDate, endDate, days } = query;

  if (startDate || endDate || days) {
    return resolveRange(query);
  }

  const since = new Date();
  since.setHours(0, 0, 0, 0); // start of today

  const until = new Date();
  until.setFullYear(until.getFullYear() + 5); // effectively "no upper bound"

  return { since, until, windowDays: null, custom: false };
}

router.get('/summary', async (req, res) => {
  const brandId = req.user.brandId;
  const { since, until, windowDays } = resolveRange(req.query);

  try {
    const byPlatform = await Conversion.aggregate([
      { $match: { brandId: new mongoose.Types.ObjectId(brandId), status: 'sent', eventTime: { $gte: since, $lte: until } } },
      { $group: { _id: '$platform', conversions: { $sum: 1 }, revenue: { $sum: '$amount' } } },
      { $sort: { revenue: -1 } },
    ]);

const totalRevenueResult = await Invoice.aggregate([
      { $match: { brandId: new mongoose.Types.ObjectId(brandId), status: 'closed', closedAt: { $gte: since, $lte: until } } },
      { $group: { _id: null, total: { $sum: '$amount' }, tax: { $sum: '$tax' }, count: { $sum: 1 } } },
    ]);
    const totalRevenue = totalRevenueResult[0] ? totalRevenueResult[0].total : 0;
    const totalTax = totalRevenueResult[0] ? totalRevenueResult[0].tax : 0;
    const totalRevenueExTax = totalRevenue - totalTax;
    const totalInvoices = totalRevenueResult[0] ? totalRevenueResult[0].count : 0;

   const AD_PLATFORMS = ['meta', 'google', 'awin'];
    const adAttributedRevenue = byPlatform
      .filter((p) => AD_PLATFORMS.includes(p._id))
      .reduce((sum, p) => sum + p.revenue, 0);
    const directRevenue = byPlatform
      .filter((p) => p._id === 'direct')
      .reduce((sum, p) => sum + p.revenue, 0);
    const unattributedRevenue = Math.max(0, totalRevenue - adAttributedRevenue - directRevenue);

    const newCustomers = await Customer.countDocuments({ brandId, firstPurchaseDate: { $gte: since, $lte: until } });
    const totalCustomersWithPurchase = await Customer.countDocuments({ brandId, firstPurchaseDate: { $ne: null } });
    const totalVisits = await Visit.countDocuments({ brandId, capturedAt: { $gte: since, $lte: until } });

   const returningCustomersResult = await Invoice.aggregate([
      { $match: { brandId: new mongoose.Types.ObjectId(brandId), status: 'closed', closedAt: { $gte: since, $lte: until }, customerId: { $ne: null } } },
      { $group: { _id: '$customerId', purchasesInRange: { $sum: 1 } } },
      { $match: { purchasesInRange: { $gte: 2 } } },
      { $count: 'count' },
    ]);
    const returningCustomers = returningCustomersResult[0] ? returningCustomersResult[0].count : 0;

    const repeatPurchaseResult = await Invoice.aggregate([
      { $match: { brandId: new mongoose.Types.ObjectId(brandId), status: 'closed', customerId: { $ne: null } } },
      { $group: { _id: '$customerId', purchaseCount: { $sum: 1 } } },
      {
        $group: {
          _id: null,
          totalCustomers: { $sum: 1 },
          repeatCustomers: { $sum: { $cond: [{ $gte: ['$purchaseCount', 2] }, 1, 0] } },
        },
      },
    ]);
    const totalCustomersAllTime = repeatPurchaseResult[0] ? repeatPurchaseResult[0].totalCustomers : 0;
    const repeatCustomers = repeatPurchaseResult[0] ? repeatPurchaseResult[0].repeatCustomers : 0;
    const retentionRate = totalCustomersAllTime ? Number(((repeatCustomers / totalCustomersAllTime) * 100).toFixed(1)) : 0;

    res.json({
      windowDays,
      rangeStart: since,
      rangeEnd: until,
      totalRevenue,
      totalRevenueExTax,
      totalTax,
      totalInvoices,
      avgOrderValue: totalInvoices ? Number((totalRevenue / totalInvoices).toFixed(2)) : 0,
    adAttributedRevenue,
      directRevenue,
      unattributedRevenue,
      byPlatform,
      newCustomers,
      returningCustomers,
      totalCustomersWithPurchase,
      totalVisits,
      retentionRate,
      repeatCustomers,
      totalCustomersAllTime,
    });
  } catch (err) {
    console.error('dashboard summary error', err);
    res.status(500).json({ error: 'Failed to build summary' });
  }
});

router.get('/campaigns', async (req, res) => {
  const brandId = req.user.brandId;
  const { since, until } = resolveForwardRange(req.query);
  const { location } = req.query;

  try {
    const results = await Conversion.aggregate([
      { $match: { brandId: new mongoose.Types.ObjectId(brandId), status: 'sent', eventTime: { $gte: since, $lte: until } } },
      // Conversions don't carry a center themselves - only the invoice they
      // came from does - so scoping campaigns to one location means joining
      // to invoices first. Skipped entirely when location is 'all'/absent.
      ...(location && location !== 'all'
        ? [
            { $lookup: { from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: 'invoice' } },
            { $unwind: '$invoice' },
            { $match: centerMatchClause(location, 'invoice.centerName') },
          ]
        : []),
      { $lookup: { from: 'visits', localField: 'attributionVisitId', foreignField: '_id', as: 'visit' } },
      { $unwind: { path: '$visit', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: {
            campaign: { $ifNull: ['$visit.utmCampaign', '(no campaign)'] },
            platform: '$platform',
          },
          conversions: { $sum: 1 },
          revenue: { $sum: '$amount' },
          uniqueCustomers: { $addToSet: '$customerId' },
        },
      },
      {
        $project: {
          _id: 1,
          conversions: 1,
          revenue: 1,
          avgOrderValue: { $cond: [{ $gt: ['$conversions', 0] }, { $divide: ['$revenue', '$conversions'] }, 0] },
          customerCount: { $size: { $filter: { input: '$uniqueCustomers', as: 'c', cond: { $ne: ['$$c', null] } } } },
        },
      },
      { $sort: { revenue: -1 } },
    ]);
    const mapped = results.map((r) => ({
      ...r,
      _id: centerName(r._id) || r._id,
    }));
    res.json({ campaigns: results });
  } catch (err) {
    console.error('dashboard locations error', err);
    res.status(500).json({ error: 'Failed to build location breakdown' });
  }
});

router.get('/campaigns/customers', async (req, res) => {
  const brandId = req.user.brandId;
  const { platform, campaign, search } = req.query;
  const { since, until } = resolveForwardRange(req.query);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);

  if (!platform || !campaign) {
    return res.status(400).json({ error: 'platform and campaign query params are required' });
  }

  try {
    const campaignMatch = campaign === '(no campaign)' ? { $in: [null, ''] } : campaign;

    const basePipeline = [
      { $match: { brandId: new mongoose.Types.ObjectId(brandId), status: 'sent', platform, eventTime: { $gte: since, $lte: until } } },
      { $lookup: { from: 'visits', localField: 'attributionVisitId', foreignField: '_id', as: 'visit' } },
      { $unwind: { path: '$visit', preserveNullAndEmptyArrays: true } },
      { $match: { 'visit.utmCampaign': campaignMatch } },
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
      { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$customerId',
          name: { $first: '$customer.name' },
          email: { $first: '$customer.email' },
          phone: { $first: '$customer.phone' },
          conversions: { $sum: 1 },
          revenue: { $sum: '$amount' },
          lastConvertedAt: { $max: '$eventTime' },
          utmSource: { $first: '$visit.utmSource' },
          utmMedium: { $first: '$visit.utmMedium' },
          landingPageUrl: { $first: '$visit.landingPageUrl' },
        },
      },
    ];

    // Search by name/email/phone happens after grouping, since those fields
    // only exist once we've joined to the customer collection.
    if (search && search.trim()) {
      const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      basePipeline.push({ $match: { $or: [{ name: re }, { email: re }, { phone: re }] } });
    }

    basePipeline.push({ $sort: { lastConvertedAt: -1 } });

    const [rows, countResult] = await Promise.all([
      Conversion.aggregate([...basePipeline, { $skip: (page - 1) * limit }, { $limit: limit }]),
      Conversion.aggregate([...basePipeline, { $count: 'total' }]),
    ]);

    const total = countResult[0] ? countResult[0].total : 0;

    res.json({
      customers: rows,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('campaign customers error', err);
    res.status(500).json({ error: 'Failed to build campaign customer list' });
  }
});

router.get('/customers', async (req, res) => {
  const brandId = req.user.brandId;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const { search, sortBy } = req.query;

  const filter = { brandId, lifetimeRevenue: { $gt: 0 } };

  // Only apply a lastPurchaseDate restriction when the user explicitly asked
  // for one (startDate/endDate/days present). With no filter, the customer
  // list should show everyone with a purchase, most-recent-first - not just
  // people who bought today-or-later, which used to hide yesterday/last
  // week's customers entirely.
  const { startDate, endDate, days } = req.query;
  if (startDate || endDate || days) {
    const { since, until } = resolveRange(req.query);
    filter.lastPurchaseDate = { $gte: since, $lte: until };
  }

  if (search && search.trim()) {
    const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: re }, { email: re }, { phone: re }];
  }

  const sort = sortBy === 'revenue' ? { lifetimeRevenue: -1 } : { lastPurchaseDate: -1 };

  try {
    const [customers, total] = await Promise.all([
      Customer.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .select('name email phone lifetimeRevenue firstPurchaseDate lastPurchaseDate'),
      Customer.countDocuments(filter),
    ]);

    res.json({
      customers,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('dashboard customers error', err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

router.get('/locations', async (req, res) => {
  const brandId = req.user.brandId;
  const { since, until } = resolveRange(req.query);

  try {
    const results = await Invoice.aggregate([
      { $match: { brandId: new mongoose.Types.ObjectId(brandId), status: 'closed', closedAt: { $gte: since, $lte: until } } },
      {
        $group: {
          _id: { $ifNull: ['$centerName', { $ifNull: ['$centerId', '(unknown location)'] }] },
          conversions: { $sum: 1 },
          revenue: { $sum: '$amount' },
        },
      },
      { $sort: { revenue: -1 } },
    ]);
    res.json({ locations: results });
  } catch (err) {
    console.error('dashboard locations error', err);
    res.status(500).json({ error: 'Failed to build location breakdown' });
  }
});

router.get('/cac', async (req, res) => {
  const brandId = req.user.brandId;
  const { since, until } = resolveRange(req.query);
  const brandObjectId = new mongoose.Types.ObjectId(brandId);

  try {
    const spendByPlatform = await AdSpend.aggregate([
      { $match: { brandId: brandObjectId, date: { $gte: since, $lte: until } } },
      { $group: { _id: '$platform', spend: { $sum: '$spend' } } },
    ]);

    const newCustomersByPlatform = await Customer.aggregate([
      { $match: { brandId: brandObjectId, firstPurchaseDate: { $gte: since, $lte: until } } },
      {
        $lookup: {
          from: 'conversions',
          let: { custId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$customerId', '$$custId'] }, { $ne: ['$platform', 'klaviyo'] }] } } },
            { $sort: { eventTime: 1 } },
            { $limit: 1 },
          ],
          as: 'firstConversion',
        },
      },
      { $unwind: '$firstConversion' },
      { $group: { _id: '$firstConversion.platform', newCustomers: { $sum: 1 } } },
    ]);

    const newCustomersMap = Object.fromEntries(newCustomersByPlatform.map((r) => [r._id, r.newCustomers]));

    const cac = spendByPlatform.map((s) => {
      const newCustomers = newCustomersMap[s._id] || 0;
      return {
        platform: s._id,
        spend: s.spend,
        newCustomers,
        cac: newCustomers ? Number((s.spend / newCustomers).toFixed(2)) : null,
      };
    });

    res.json({ cac });
  } catch (err) {
    console.error('dashboard cac error', err);
    res.status(500).json({ error: 'Failed to build CAC breakdown' });
  }
});
// GET /api/dashboard/recent-purchases?limit=10
// Latest closed invoices with customer + platform info - "who just bought
// something" view, most recent first.
router.get('/recent-purchases', async (req, res) => {
  const brandId = req.user.brandId;
  const limit = Math.min(50, Number(req.query.limit) || 10);
  const { location } = req.query;

  try {
    const results = await Invoice.aggregate([
      {
        $match: {
          brandId: new mongoose.Types.ObjectId(brandId),
          status: 'closed',
          ...centerMatchClause(location),
        },
      },
      { $sort: { closedAt: -1 } },
      { $limit: limit },
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
      { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'conversions',
          let: { invId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$invoiceId', '$$invId'] }, { $ne: ['$platform', 'klaviyo'] }] } } },
            { $limit: 1 },
          ],
          as: 'conversion',
        },
      },
      { $unwind: { path: '$conversion', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          amount: 1,
          closedAt: 1,
          centerId: 1,
          centerName: 1,
          zenotiInvoiceId: 1,
          customerName: '$customer.name',
          customerEmail: '$customer.email',
          platform: { $ifNull: ['$conversion.platform', 'direct'] },
        },
      },
    ]);
    const mapped = results.map((r) => ({
      ...r,
      centerName: centerName(r.centerId) || r.centerName || null,
    }));
    res.json({ purchases: mapped });
  } catch (err) {
    console.error('dashboard recent-purchases error', err);
    res.status(500).json({ error: 'Failed to build recent purchases list' });
  }
});

// GET /api/dashboard/center-list
// Static catalog of known locations, independent of whether they have any
// data in a given date range - powers the location picker on the Master
// Report page so a center with zero revenue this week doesn't just vanish
// from the dropdown.
router.get('/center-list', (req, res) => {
  const centers = Object.entries(CENTER_NAMES).map(([id, name]) => ({ id, name }));
  res.json({ centers });
});

// GET /api/dashboard/location-report?location=<name|all|(unknown location)>&days=/startDate/endDate
// Single-location rollup: revenue, invoices, AOV, revenue-by-platform, and
// recent purchases, all scoped to one center. Only Invoice (and anything
// joined off of it) carries a center in this data model, so this endpoint
// is intentionally invoice-rooted - it does NOT attempt to split
// new/returning customers, tracked visits, or ad spend/CAC by location,
// because Customer, Visit, and AdSpend records have no center field to
// scope by. Those stay brand-wide; the frontend should present them
// separately, labeled as company-wide.
router.get('/location-report', async (req, res) => {
  const brandId = req.user.brandId;
  const brandObjectId = new mongoose.Types.ObjectId(brandId);
  const { since, until, windowDays } = resolveRange(req.query);
  const { location } = req.query;

  try {
    const invoiceMatch = {
      brandId: brandObjectId,
      status: 'closed',
      closedAt: { $gte: since, $lte: until },
      ...centerMatchClause(location),
    };

    const totalsResult = await Invoice.aggregate([
      { $match: invoiceMatch },
      { $group: { _id: null, totalRevenue: { $sum: '$amount' }, totalInvoices: { $sum: 1 } } },
    ]);
    const totalRevenue = totalsResult[0] ? totalsResult[0].totalRevenue : 0;
    const totalInvoices = totalsResult[0] ? totalsResult[0].totalInvoices : 0;

    const byPlatform = await Conversion.aggregate([
      { $match: { brandId: brandObjectId, status: 'sent', eventTime: { $gte: since, $lte: until } } },
      { $lookup: { from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: 'invoice' } },
      { $unwind: '$invoice' },
      { $match: { 'invoice.status': 'closed', 'invoice.closedAt': { $gte: since, $lte: until }, ...centerMatchClause(location, 'invoice.centerName') } },
      { $group: { _id: '$platform', conversions: { $sum: 1 }, revenue: { $sum: '$amount' } } },
      { $sort: { revenue: -1 } },
    ]);

    const recentPurchases = await Invoice.aggregate([
      { $match: invoiceMatch },
      { $sort: { closedAt: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
      { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'conversions',
          let: { invId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$invoiceId', '$$invId'] }, { $ne: ['$platform', 'klaviyo'] }] } } },
            { $limit: 1 },
          ],
          as: 'conversion',
        },
      },
      { $unwind: { path: '$conversion', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          amount: 1,
          closedAt: 1,
          centerName: 1,
          customerName: '$customer.name',
          customerEmail: '$customer.email',
          platform: { $ifNull: ['$conversion.platform', 'direct'] },
        },
      },
    ]);

    res.json({
      location: location && location !== 'all' ? location : 'all',
      windowDays,
      rangeStart: since,
      rangeEnd: until,
      totalRevenue,
      totalInvoices,
      avgOrderValue: totalInvoices ? Number((totalRevenue / totalInvoices).toFixed(2)) : 0,
      byPlatform,
      recentPurchases,
    });
  } catch (err) {
    console.error('dashboard location-report error', err);
    res.status(500).json({ error: 'Failed to build location report' });
  }
});

// GET /api/dashboard/trend?days=/startDate/endDate&location=
// Time-bucketed series for charts: revenue + invoices + new customers per
// bucket, plus revenue per bucket broken out by platform. Bucket width
// (day/week/month) is chosen automatically based on the range length.
// Same location scoping rules as location-report - new customers stay
// company-wide since Customer has no center field.
router.get('/trend', async (req, res) => {
  const brandId = req.user.brandId;
  const brandObjectId = new mongoose.Types.ObjectId(brandId);
  const { since, until, windowDays } = resolveRange(req.query);
  const { location } = req.query;
  const { granularity, format } = pickGranularity(windowDays);

  try {
    const revenueRows = await Invoice.aggregate([
      {
        $match: {
          brandId: brandObjectId,
          status: 'closed',
          closedAt: { $gte: since, $lte: until },
          ...centerMatchClause(location),
        },
      },
      {
        $group: {
          _id: { $dateToString: { format, date: '$closedAt' } },
          revenue: { $sum: '$amount' },
          invoices: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Company-wide regardless of location filter - see note on /location-report.
    const newCustomerRows = await Customer.aggregate([
      { $match: { brandId: brandObjectId, firstPurchaseDate: { $gte: since, $lte: until } } },
      { $group: { _id: { $dateToString: { format, date: '$firstPurchaseDate' } }, newCustomers: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

   const platformRows = await Conversion.aggregate([
      { $match: { brandId: brandObjectId, status: 'sent', eventTime: { $gte: since, $lte: until } } },
      ...(location && location !== 'all'
        ? [
            { $lookup: { from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: 'invoice' } },
            { $unwind: '$invoice' },
            { $match: centerMatchClause(location, 'invoice.centerName') },
          ]
        : []),
      {
        $group: {
          _id: { bucket: { $dateToString: { format, date: '$eventTime' } }, platform: '$platform' },
          revenue: { $sum: '$amount' },
        },
      },
      { $sort: { '_id.bucket': 1 } },
    ]);

    const bucketMap = new Map();
    for (const r of revenueRows) {
      bucketMap.set(r._id, { date: r._id, revenue: r.revenue, invoices: r.invoices, newCustomers: 0 });
    }
    for (const n of newCustomerRows) {
      const existing = bucketMap.get(n._id) || { date: n._id, revenue: 0, invoices: 0, newCustomers: 0 };
      existing.newCustomers = n.newCustomers;
      bucketMap.set(n._id, existing);
    }
    const series = Array.from(bucketMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    const platformSeries = {};
    for (const p of platformRows) {
      const platform = p._id.platform;
      if (!platformSeries[platform]) platformSeries[platform] = [];
      platformSeries[platform].push({ date: p._id.bucket, revenue: p.revenue });
    }

    res.json({ granularity, rangeStart: since, rangeEnd: until, series, platformSeries });
  } catch (err) {
    console.error('dashboard trend error', err);
    res.status(500).json({ error: 'Failed to build trend' });
  }
});

router.get('/transactions', async (req, res) => {
  const brandId = req.user.brandId;
  const { since, until } = resolveRange(req.query);
  const { search, platform, location } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 25);

  try {
    const matchStage = {
      brandId: new mongoose.Types.ObjectId(brandId),
      status: 'closed',
      closedAt: { $gte: since, $lte: until },
      ...centerMatchClause(location),
    };

    const pipeline = [
      { $match: matchStage },
      { $unwind: '$items' },
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
      { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'conversions',
          let: { invId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$invoiceId', '$$invId'] },
              { $ne: ['$platform', 'klaviyo'] },
              { $eq: ['$status', 'sent'] },
            ] } } },
            { $limit: 1 },
          ],
          as: 'conversion',
        },
      },
      { $unwind: { path: '$conversion', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'visits', localField: 'conversion.attributionVisitId', foreignField: '_id', as: 'visit' } },
      { $unwind: { path: '$visit', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'conversions',
          let: { invId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$invoiceId', '$$invId'] }, { $eq: ['$status', 'sent'] }] } } },
            { $project: { _id: 0, platform: 1 } },
          ],
          as: 'allConversions',
        },
      },
      {
        $addFields: {
          campaign: { $ifNull: ['$visit.utmCampaign', '(no campaign)'] },
          platformLabel: { $ifNull: ['$conversion.platform', 'unattributed'] },
          platformList: '$allConversions.platform',
        },
      },
     { $sort: { closedAt: -1 } },
      {
        $facet: {
          data: [
            ...(platform && platform !== 'all' ? [{ $match: { platformList: platform } }] : []),
            ...(search && search.trim()
              ? [{
                  $match: {
                    $or: [
                      { 'customer.name': { $regex: search.trim(), $options: 'i' } },
                      { 'customer.email': { $regex: search.trim(), $options: 'i' } },
                      { 'items.name': { $regex: search.trim(), $options: 'i' } },
                      { campaign: { $regex: search.trim(), $options: 'i' } },
                    ],
                  },
                }]
              : []),
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                invoiceId: '$_id',
                customerName: '$customer.name',
                email: '$customer.email',
                productName: '$items.name',
                price: '$items.price',
                location: '$centerName',
                platform: '$platformLabel',
                campaign: '$campaign',
                purchaseDate: '$closedAt',
              },
            },
          ],
          totalCount: [
            ...(platform && platform !== 'all' ? [{ $match: { platformList: platform } }] : []),
            ...(search && search.trim()
              ? [{
                  $match: {
                    $or: [
                      { 'customer.name': { $regex: search.trim(), $options: 'i' } },
                      { 'customer.email': { $regex: search.trim(), $options: 'i' } },
                      { 'items.name': { $regex: search.trim(), $options: 'i' } },
                      { campaign: { $regex: search.trim(), $options: 'i' } },
                    ],
                  },
                }]
              : []),
            { $count: 'count' },
          ],
          // All platforms present for this date range/location, regardless of
          // the platform filter itself - powers the dropdown so it always
          // shows every real option instead of collapsing to whatever's
          // currently selected.
          availablePlatforms: [
            { $unwind: '$platformList' },
            { $group: { _id: '$platformList' } },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ];

  const [result] = await Invoice.aggregate(pipeline);
    const total = result.totalCount[0] ? result.totalCount[0].count : 0;
    const availablePlatforms = result.availablePlatforms.map((p) => p._id).filter(Boolean);

    res.json({
      transactions: result.data,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      availablePlatforms,
    });
  } catch (err) {
    console.error('dashboard transactions error', err);
    res.status(500).json({ error: 'Failed to build transactions list' });
  }
});


// Lists refund invoices (Invoice.isRefund: true) with the customer who was
// refunded, for a given date range/location. Paginated the same way as
// /transactions. Note: refund amounts are already netted into every
// revenue total elsewhere on the dashboard (they're closed invoices with a
// negative amount) - this endpoint exists purely for visibility into who/
// what/how much was refunded, not to recompute any totals.
router.get('/refunds', async (req, res) => {
  const brandId = req.user.brandId;
  const brandObjectId = new mongoose.Types.ObjectId(brandId);
  const { since, until } = resolveRange(req.query);
  const { location } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  try {
    const match = {
      brandId: brandObjectId,
      isRefund: true,
      closedAt: { $gte: since, $lte: until },
      ...centerMatchClause(location),
    };

    const [totalsResult, refunds, totalCountResult] = await Promise.all([
      Invoice.aggregate([
        { $match: match },
        { $group: { _id: null, totalRefunded: { $sum: '$amount' }, refundCount: { $sum: 1 } } },
      ]),
      Invoice.aggregate([
        { $match: match },
        { $sort: { closedAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
        { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            amount: 1,
            closedAt: 1,
            centerName: 1,
            zenotiInvoiceId: 1,
            items: 1,
            customerName: { $ifNull: ['$customer.name', 'Unknown guest'] },
            customerEmail: '$customer.email',
            customerPhone: '$customer.phone',
          },
        },
      ]),
      Invoice.countDocuments(match),
    ]);

    res.json({
      location: location && location !== 'all' ? location : 'all',
      rangeStart: since,
      rangeEnd: until,
      totalRefunded: totalsResult[0] ? totalsResult[0].totalRefunded : 0, // negative number
      refundCount: totalsResult[0] ? totalsResult[0].refundCount : 0,
      refunds,
      page,
      limit,
      total: totalCountResult,
      totalPages: Math.max(1, Math.ceil(totalCountResult / limit)),
    });
  } catch (err) {
    console.error('dashboard refunds error', err);
    res.status(500).json({ error: 'Failed to build refunds list' });
  }
});

module.exports = router;