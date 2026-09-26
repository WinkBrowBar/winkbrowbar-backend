// checkGoogleCredentials.js
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const MarketingPlatform = require('./src/db/models/MarketingPlatform');
const Conversion = require('./src/db/models/Conversion');

(async () => {
  await connectDB();

  console.log('\n=== MarketingPlatform records for "google" (any status) ===');
  const records = await MarketingPlatform.find({ platform: 'google' }).lean();
  if (!records.length) {
    console.log('NONE FOUND - no google record exists in this collection at all, active or not.');
  } else {
    for (const r of records) {
      console.log({
        _id: r._id.toString(),
        brandId: r.brandId.toString(),
        isActive: r.isActive,
        credentialKeys: Object.keys(r.credentials || {}),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      });
    }
  }

  console.log('\n=== Most recent successfully-SENT google conversions (up to 10) ===');
  const sent = await Conversion.find({ platform: 'google', status: 'sent' }).sort({ sentAt: -1 }).limit(10).lean();
  if (!sent.length) {
    console.log('None ever recorded as sent.');
  } else {
    for (const c of sent) {
      console.log({ invoiceId: c.invoiceId.toString(), sentAt: c.sentAt, amount: c.amount, platformResponse: c.platformResponse });
    }
  }

  console.log('\n=== Most recent FAILED google conversions (up to 10) ===');
  const failed = await Conversion.find({ platform: 'google', status: 'failed' }).sort({ updatedAt: -1 }).limit(10).lean();
  if (!failed.length) {
    console.log('None recorded as failed either.');
  } else {
    for (const c of failed) {
      console.log({ invoiceId: c.invoiceId.toString(), updatedAt: c.updatedAt, platformResponse: c.platformResponse });
    }
  }

  process.exit(0);
})();