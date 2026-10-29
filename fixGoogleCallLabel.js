// fixGoogleCallLabel.js
// One-off: call-lead matches recorded by the old code as 'google' -> 'google_call'.
// Usage: node fixGoogleCallLabel.js [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');

(async () => {
  await connectDB();
  const filter = { attributionModelUsed: 'call_lead_phone_match', platform: 'google' };
  const found = await Conversion.countDocuments(filter);
  console.log(`Found ${found} call-lead conversion(s) labeled 'google'`);
  if (found && !process.argv.includes('--dry-run')) {
    const res = await Conversion.updateMany(filter, { $set: { platform: 'google_call' } });
    console.log(`Updated ${res.modifiedCount} -> 'google_call'`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });