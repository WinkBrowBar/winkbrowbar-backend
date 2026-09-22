const Invoice = require('../db/models/Invoice');
const Customer = require('../db/models/Customer');
const MarketingPlatform = require('../db/models/MarketingPlatform');
const Conversion = require('../db/models/Conversion');
const { pickAttributedVisit, platformFromVisit } = require('./attribution');
const { getConnector } = require('../connectors');

async function sendToPlatform({ brandId, invoice, customer, platform, clickId, visitId, modelUsed }) {
  const existing = await Conversion.findOne({ invoiceId: invoice._id, platform });
  if (existing) {
    return {
      skipped: true,
      platform,
      reason: `Conversion already ${existing.status} for this invoice+platform - skipping duplicate send`,
      conversionId: existing._id,
    };
  }

  const platformCreds = await MarketingPlatform.findOne({ brandId, platform, isActive: true });
  if (!platformCreds) {
    return { skipped: true, platform, reason: `No active credentials configured for ${platform} on this brand` };
  }

  let conversionRecord;
  try {
    conversionRecord = await Conversion.create({
      brandId,
      invoiceId: invoice._id,
      customerId: customer._id,
      attributionVisitId: visitId || null,
      attributionModelUsed: modelUsed || null,
      platform,
      amount: invoice.amount,
      eventTime: invoice.closedAt,
      status: 'pending',
    });
  } catch (err) {
    if (err.code === 11000) {
      const raceWinner = await Conversion.findOne({ invoiceId: invoice._id, platform });
      return { skipped: true, platform, reason: 'Duplicate conversion prevented by unique index (concurrent send)', conversionId: raceWinner ? raceWinner._id : null };
    }
    throw err;
  }

  const connector = getConnector(platform);
  const result = await connector.send(
    {
      clickId: clickId || null,
      email: customer.email,
      phone: customer.phone,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      orderId: invoice.zenotiInvoiceId,
      eventTime: invoice.closedAt,
    },
    platformCreds.credentials
  );

  conversionRecord.status = result.success ? 'sent' : 'failed';
  conversionRecord.platformResponse = result.response || { error: result.error };
  conversionRecord.sentAt = new Date();
  await conversionRecord.save();

  return { skipped: false, platform, success: result.success, conversionId: conversionRecord._id };
}

async function processInvoiceConversion({ brandId, invoiceId }) {
  const invoice = await Invoice.findOne({ _id: invoiceId, brandId });
  if (!invoice) throw new Error('Invoice not found');
  if (!invoice.customerId) {
    return { skipped: true, reason: 'No customer linked to this invoice - cannot attribute or notify' };
  }

  const claimed = await Invoice.findOneAndUpdate(
    { _id: invoiceId, brandId, conversionsProcessedAt: null },
    { $set: { conversionsProcessedAt: new Date() } }
  );
  if (!claimed) {
    return { skipped: true, reason: 'Invoice already processed - conversions were already sent for this invoice, skipping to avoid duplicate revenue/conversions' };
  }

  try {
  const customer = await Customer.findById(invoice.customerId);
    const result = await processConversionsForInvoice({ brandId, invoice, customer });

    // Only credit the customer's totals once conversion processing has
    // actually succeeded - doing this earlier meant a retry (e.g. after a
    // transient failure) could double-count the same invoice's revenue.
    const invoiceClosedAt = invoice.closedAt || new Date();
    customer.lifetimeRevenue = (customer.lifetimeRevenue || 0) + Number(invoice.amount);
    if (!customer.firstPurchaseDate) {
      customer.firstPurchaseDate = invoiceClosedAt;
    }
    if (!customer.lastPurchaseDate || invoiceClosedAt > customer.lastPurchaseDate) {
      customer.lastPurchaseDate = invoiceClosedAt;
    }
    await customer.save();

    return result;
  } catch (err) {
    await Invoice.updateOne({ _id: invoiceId, brandId }, { $set: { conversionsProcessedAt: null } });
    throw err;
  }
}

async function processConversionsForInvoice({ brandId, invoice, customer }) {
  const results = { adPlatform: null, klaviyo: null, organicSource: null };

  const { visit, modelUsed } = await pickAttributedVisit({
    brandId,
    customerId: invoice.customerId,
    beforeTimestamp: invoice.closedAt,
  });

  if (!visit) {
    results.adPlatform = { skipped: true, reason: 'No tracked visit found for this customer - likely a walk-in or untracked source' };
  } else {
    const attribution = platformFromVisit(visit);
    if (!attribution) {
      results.adPlatform = { skipped: true, reason: 'Visit found but no click id present' };
    } else {
      results.adPlatform = await sendToPlatform({
        brandId,
        invoice,
        customer,
        platform: attribution.platform,
        clickId: attribution.clickId,
        visitId: visit._id,
        modelUsed,
      });
    }
  }

  if (results.adPlatform && results.adPlatform.skipped) {
    const { visit: organicVisit } = await pickAttributedVisit({
      brandId,
      customerId: invoice.customerId,
      beforeTimestamp: invoice.closedAt,
      requireClickId: false,
    });

    const sourceLabel = (organicVisit && organicVisit.utmSource) ? organicVisit.utmSource.toLowerCase() : 'direct';

    try {
const conversionRecord = await Conversion.create({
        brandId,
        invoiceId: invoice._id,
        customerId: customer._id,
        attributionVisitId: organicVisit ? organicVisit._id : null,
        attributionModelUsed: organicVisit ? modelUsed : null,
        platform: sourceLabel,
        amount: invoice.amount,
        eventTime: invoice.closedAt,
        status: 'sent',
        sentAt: new Date(),
      });

      results.organicSource = { skipped: false, platform: sourceLabel, conversionId: conversionRecord._id };
    } catch (err) {
      if (err.code === 11000) {
        results.organicSource = { skipped: true, platform: sourceLabel, reason: 'Duplicate conversion prevented by unique index' };
      } else {
        throw err;
      }
    }
  }

  const { visit: klaviyoVisit } = await pickAttributedVisit({
    brandId,
    customerId: invoice.customerId,
    beforeTimestamp: invoice.closedAt,
    requireClickId: false,
  });

  results.klaviyo = await sendToPlatform({
    brandId,
    invoice,
    customer,
    platform: 'klaviyo',
    visitId: klaviyoVisit ? klaviyoVisit._id : null,
  });

  return results;
}

module.exports = { processInvoiceConversion };