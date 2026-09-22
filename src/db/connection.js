const mongoose = require('mongoose');
require('dotenv').config();

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
