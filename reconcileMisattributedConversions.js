// reconcileMisattributedConversions.js
// Usage:
//   node reconcileMisattributedConversions.js [days=60]              -> dry run, report only
//   node reconcileMisattributedConversions.js [days=60] --send       -> actually send corrected conversions
//
// Root cause this fixes: conversion attribution runs exactly once, at the
// moment an invoice closes. If a customer identity merge (guest.merged)
// happens AFTER that - which reassigns a Visit's customerId onto the
// correct, merged customer - the ad-click visit becomes findable NOW but
// was invisible at the time the invoice actually closed. That invoice
// permanently got recorded as platform "direct" and NOTHING was ever sent
// to the real ad platform - not a failed attempt, no attempt at all.
//
// This finds every closed invoice with a customer but no successful
// google/meta/awin Conversion, re-runs the exact same attribution lookup
// RIGHT NOW, and - only when explicitly asked to --send - creates and sends
// the real conversion via the same sendToPlatform() path a normal, on-time
// conversion would have used.
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const Customer = require('./src/db/models/Customer');
const Conversion = require('./src/db/models/Conversion');
const { pickAttributedVisit, platformFromVisit } = require('./src/services/attribution');
const { sendToPlatform } = require('./src/services/conversionService');

const days = Number(process.argv[2]) || 60;
const shouldSend = process.argv.includes('--send');

(async () => {
  await connectDB();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const invoices = await Invoice.find({
    status: 'closed',
    customerId: { $ne: null },
    closedAt: { $gte: since },
  });

  console.log(`\nChecking ${invoices.length} closed invoices from the last ${days} days...`);
  console.log(shouldSend ? 'MODE: LIVE - will actually send corrected conversions.\n' : 'MODE: DRY RUN - reporting only, nothing will be sent. Add --send to actually fix these.\n');

  let checked = 0;
  let alreadyOk = 0;
  let corrected = 0;
  const toFix = [];
  const skippedNonPositive = [];

  for (const invoice of invoices) {
    checked++;
    const existingAdConversion = await Conversion.findOne({
      invoiceId: invoice._id,
      platform: { $in: ['google', 'meta', 'awin'] },
      status: 'sent',
    });
    if (existingAdConversion) { alreadyOk++; continue; }

    const { visit, modelUsed } = await pickAttributedVisit({
      brandId: invoice.brandId,
      customerId: invoice.customerId,
      beforeTimestamp: invoice.closedAt,
    });
    if (!visit) continue; // genuinely no ad-click visit exists - correctly organic/direct

    const attribution = platformFromVisit(visit);
    if (!attribution) continue; // shouldn't happen given requireClickId defaulted true above, but be safe

    // A $0 or negative amount isn't a real sale to report - $0 is typically
    // a comped/free service, negative is almost always a refund or credit
    // adjustment. Sending either to an ad platform as a "purchase" is
    // meaningless at best and could be rejected or misread at worst.
    if (!(Number(invoice.amount) > 0)) {
      skippedNonPositive.push({ invoice, attribution });
      continue;
    }

    toFix.push({ invoice, visit, modelUsed, attribution });
  }

  console.log(`Already correctly attributed to an ad platform: ${alreadyOk}`);
  console.log(`Genuinely organic/direct (no ad-click visit exists): ${checked - alreadyOk - toFix.length - skippedNonPositive.length}`);
  console.log(`MISATTRIBUTED - real ad-click visit exists now but no ad-platform conversion was ever sent: ${toFix.length}`);
  if (skippedNonPositive.length) {
    console.log(`SKIPPED - would qualify, but amount is $0 or negative (refund/comp, not a real sale to report): ${skippedNonPositive.length}`);
    for (const { invoice, attribution } of skippedNonPositive) {
      console.log(`    (skipped) invoice ${invoice.invoiceNumber || invoice.zenotiInvoiceId} | $${invoice.amount} | would have been: ${attribution.platform}`);
    }
  }
  console.log('');

  for (const { invoice, visit, modelUsed, attribution } of toFix) {
    const customer = await Customer.findById(invoice.customerId).lean();
    const label = `${customer ? customer.name || customer.email : invoice.customerId} | invoice ${invoice.invoiceNumber || invoice.zenotiInvoiceId} | $${invoice.amount} | closed ${invoice.closedAt.toISOString().slice(0, 10)} | should be: ${attribution.platform}`;

    if (!shouldSend) {
      console.log(`  [would fix] ${label}`);
      continue;
    }

    const result = await sendToPlatform({
      brandId: invoice.brandId,
      invoice,
      customer,
      platform: attribution.platform,
      clickId: attribution.clickId,
      visitId: visit._id,
      modelUsed,
    });
    console.log(`  [${result.success ? 'SENT' : result.skipped ? 'skipped' : 'FAILED'}] ${label}`, result.skipped ? `(${result.reason})` : '');
    if (result.success) corrected++;
  }

  if (shouldSend) {
    console.log(`\nDone. Successfully sent ${corrected} of ${toFix.length} corrected conversions.`);
  } else {
    console.log(`\nDry run complete. Re-run with --send to actually send these ${toFix.length} corrected conversions.`);
  }
  process.exit(0);
})();