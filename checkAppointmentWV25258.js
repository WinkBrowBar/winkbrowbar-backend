require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Appointment = require('./src/db/models/Appointment');

(async () => {
  await connectDB();
  const appts = await Appointment.find({ invoiceNumber: 'WV25258' }).lean();
  console.log(JSON.stringify(appts, null, 2));
  process.exit(0);
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });