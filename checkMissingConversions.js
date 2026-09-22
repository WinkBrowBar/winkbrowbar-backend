// checkMissingConversions.js
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Invoice = require('./src/db/models/Invoice');
const Conversion = require('./src/db/models/Conversion');

(async () => {
  await connectDB();

  const recent = await Invoice.find({ status: 'closed', customerId: { $ne: null } })
    .sort({ closedAt: -1 })
    .limit(20);

  for (const inv of recent) {
    const conv = await Conversion.findOne({ invoiceId: inv._id });
    console.log(
      `${inv.closedAt.toISOString().slice(0, 10)} | invoice ${inv._id} | conversionsProcessedAt=${inv.conversionsProcessedAt} | conversion found: ${conv ? conv.platform + '/' + conv.status : 'NONE'}`
    );
  }
  process.exit(0);
})();