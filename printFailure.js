require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Conversion = require('./src/db/models/Conversion');

(async () => {
  await connectDB();
  const c = await Conversion.findOne({ platform: 'google', status: 'failed' }).sort({ createdAt: -1 }).lean();
  console.log(JSON.stringify(c.platformResponse, null, 2));
  process.exit(0);
})();