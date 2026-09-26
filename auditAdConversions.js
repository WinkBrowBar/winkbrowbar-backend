// auditAdConversions.js
// Usage: node auditAdConversions.js [days=30] [platform=google|meta]
//
// Two things this checks, since Google/Meta's own dashboards don't give you
// customer-level detail to trace one case at a time:
//
// 1. SEND FAILURES - every attempt (success or failure) is already logged
//    in the Conversion collection. This groups failures by reason so you
//    can see if something is systematically breaking (expired credentials,
//    invalid click ids, etc) rather than working invoice-by-invoice.
//
// 2. MISSED CONVERSIONS - finds real ad-click visits (gclid/fbclid present)
//    where the customer's invoice closed within the 30-day attribution
//    window, but no successfully-sent Conversion exists for that
//    invoice+platform. This is the actual gap between "ad platform says
//    they converted" and "we told the ad platform about it."
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Visit = require('./src/db/models/Visit');
const Customer = require('./src/db/models/Customer');
const Invoice = require('./src/db/models/Invoice');
const Conversion = require('./src/db/models/Conversion');

const days = Number(process.argv[2]) || 30;
const platformFilter = process.argv[3] || null; // 'google' | 'meta' | null for both
const ATTRIBUTION_WINDOW_DAYS = 30;

(async () => {
  await connectDB();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const platforms = platformFilter ? [platformFilter] : ['google', 'meta'];

  console.log(`\n=== Auditing ${platforms.join(' & ')} conversions, last ${days} days ===\n`);

  // --- Section 1: send failures already logged ---
  console.log('--- Section 1: Send attempts already logged ---');
  for (const platform of platforms) {
    const convs = await Conversion.find({ platform, eventTime: { $gte: since } });
    const byStatus = {};
    for (const c of convs) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    console.log(`\n${platform}: ${convs.length} total attempts -`, byStatus);

    const failed = convs.filter((c) => c.status === 'failed');
    if (failed.length) {
      const reasons = {};
      for (const c of failed) {
        const reason = (c.platformResponse && (c.platformResponse.error || JSON.stringify(c.platformResponse))) || 'unknown';
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
      console.log(`  Failure reasons:`);
      for (const [reason, count] of Object.entries(reasons)) {
        console.log(`    (${count}x) ${reason}`);
      }
    }
  }

  // --- Section 2: real ad clicks that never resulted in a sent conversion ---
  console.log('\n--- Section 2: Real ad-click visits vs. what actually got sent ---');
  for (const platform of platforms) {
    const clickField = platform === 'google' ? 'gclid' : 'fbclid';
    const visits = await Visit.find({
      [clickField]: { $ne: null, $exists: true },
      capturedAt: { $gte: since },
    }).lean();

    let noCustomer = 0;
    let noInvoiceYet = 0;
    let sentOk = 0;
    let missed = [];

    for (const visit of visits) {
      if (!visit.customerId) { noCustomer++; continue; }

      const windowEnd = new Date(visit.capturedAt.getTime() + ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const invoice = await Invoice.findOne({
        customerId: visit.customerId,
        status: 'closed',
        closedAt: { $gte: visit.capturedAt, $lte: windowEnd },
      });

      if (!invoice) { noInvoiceYet++; continue; }

      const conversion = await Conversion.findOne({ invoiceId: invoice._id, platform });
      if (conversion && conversion.status === 'sent') {
        sentOk++;
      } else {
        const customer = await Customer.findById(visit.customerId).lean();
        missed.push({
          customer: customer ? customer.name || customer.email : visit.customerId,
          invoiceNumber: invoice.invoiceNumber || invoice.zenotiInvoiceId,
          amount: invoice.amount,
          closedAt: invoice.closedAt,
          reason: conversion ? `conversion exists but status is "${conversion.status}"` : 'no conversion record was ever created for this invoice+platform',
        });
      }
    }

    console.log(`\n${platform} (${clickField}): ${visits.length} tracked ad clicks in this window`);
    console.log(`  -> ${noCustomer} never got linked to a customer (never identified via email)`);
    console.log(`  -> ${noInvoiceYet} haven't had a matching invoice close yet (or none ever will)`);
    console.log(`  -> ${sentOk} correctly sent as a conversion`);
    console.log(`  -> ${missed.length} REAL MISSES - clicked this ad, invoice closed, but nothing (or a failure) was sent:`);
    for (const m of missed.slice(0, 20)) {
      console.log(`       ${m.customer} | invoice ${m.invoiceNumber} | $${m.amount} | closed ${m.closedAt.toISOString().slice(0, 10)} | ${m.reason}`);
    }
    if (missed.length > 20) console.log(`       ...and ${missed.length - 20} more`);
  }

  console.log('\nDone.\n');
  process.exit(0);
})();