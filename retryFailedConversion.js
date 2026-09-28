// retryFailedConversion.js
//
// sendToPlatform() in conversionService.js treats ANY existing Conversion
// doc - even one with status "failed" - as already handled, and refuses to
// send again (the unique invoiceId+platform index also physically blocks a
// second doc). That means a real, transient failure (like the missing-
// encoding bug) becomes permanent: nothing will ever retry it on its own.
//
// This deletes ONE specific failed Conversion doc (never a "sent" one -
// guarded below) so the next reconcile/reprocess run can create a fresh one
// and actually try again, now that the underlying bug is fixed.
//
// Usage:
//   node retryFailedConversion.js <invoiceNumber> <platform>
//   node retryFailedConversion.js CH19633 google

require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const Conversion = require('./src/db/models/Conversion');

(async () => {
  const invoiceNumber = process.argv[2];
  const platform = process.argv[3];

  if (!invoiceNumber || !platform) {
    console.error('Usage: node retryFailedConversion.js <invoiceNumber> <platform>');
    process.exit(1);
  }

  await connectDB();

  const invoice = await Invoice.findOne({ invoiceNumber });
  if (!invoice) {
    console.error(`No invoice found with invoiceNumber "${invoiceNumber}"`);
    process.exit(1);
  }

  const conversion = await Conversion.findOne({ invoiceId: invoice._id, platform });
  if (!conversion) {
    console.log(`No Conversion doc exists for invoice ${invoiceNumber} + ${platform} - nothing to retry, it'll be picked up as new on the next reconcile run.`);
    process.exit(0);
  }

  if (conversion.status === 'sent') {
    console.error(`REFUSING: this conversion is already status "sent" (sentAt ${conversion.sentAt}) - not touching a real successful send.`);
    process.exit(1);
  }

  console.log(`Deleting stuck conversion:`, {
    invoiceNumber,
    platform,
    status: conversion.status,
    createdAt: conversion.createdAt,
  });

  await Conversion.deleteOne({ _id: conversion._id });

  console.log('\nDeleted. Now run:');
  console.log('  node reconcileMisattributedConversions.js 2 --send');
  console.log('to actually resend it with the fixed code.');

  process.exit(0);
})();