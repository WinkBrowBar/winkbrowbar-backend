// checkApptGuestId.js
// Usage: node checkApptGuestId.js --brand=<brandId or slug> --invoice=WV24898
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/db/connection');
const Brand = require('./src/db/models/Brand');
const Appointment = require('./src/db/models/Appointment');

function argValue(name) {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

(async () => {
  const brand = mongoose.isValidObjectId(argValue('brand'))
    ? await (await connectDB(), Brand.findById(argValue('brand')))
    : await (await connectDB(), Brand.findOne({ slug: argValue('brand') }));
  const appt = await Appointment.findOne({ brandId: brand._id, invoiceNumber: argValue('invoice') }).lean();
  console.log(appt);
  process.exit(0);
})();