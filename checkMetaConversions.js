// Run this on your Mac or EC2 (wherever you normally run these scripts),
// inside the backend project folder so it can pick up DATABASE_URL and the
// existing Mongoose models.
require('dotenv').config();
const dns = require('dns');
// Node's internal DNS resolver (c-ares) can't reliably do SRV lookups
// against an IPv6 link-local resolver (fe80::...), which is what some
// Macs hand it - even though the OS's own resolver (nslookup) works fine.
// Forcing a public DNS server here fixes mongodb+srv:// resolution.
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.DATABASE_URL);
  console.log('Connected to', mongoose.connection.name);

  const Conversion = require('./src/db/models/Conversion');
  const Visit = require('./src/db/models/Visit');

  const metaCount = await Conversion.countDocuments({ platform: 'meta' });
  console.log(`\nConversions with platform=meta: ${metaCount}`);

  const metaSample = await Conversion.find({ platform: 'meta' }).sort({ eventTime: -1 }).limit(5).lean();
  console.log('Most recent 5 meta conversions:', JSON.stringify(metaSample, null, 2));

  // What a visit that actually came from a Meta ad looks like, including the
  // raw landing URL we stored at the time.
  const metaVisit = await Visit.findOne({ fbclid: { $ne: null } }).sort({ capturedAt: -1 }).lean();
  console.log('\nMost recent visit with an fbclid (the raw URL we stored):', JSON.stringify(metaVisit, null, 2));

  const metaVisitCount = await Visit.countDocuments({ fbclid: { $ne: null } });
  console.log(`\nTotal visits ever stored with an fbclid: ${metaVisitCount}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});