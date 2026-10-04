const mongoose = require('mongoose');
const dns = require('dns');
require('dotenv').config();

// Some local networks hand out a router/ISP DNS server that can't resolve
// mongodb+srv SRV records (Atlas needs those). Forcing Node to query
// Google/Cloudflare directly sidesteps that, independent of system DNS
// settings. Safe to leave in for everyone - it only affects this process.
dns.setServers(['8.8.8.8', '1.1.1.1']);

async function connectDB() {
  try {
    await mongoose.connect(process.env.DATABASE_URL);
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});

module.exports = { connectDB, mongoose };