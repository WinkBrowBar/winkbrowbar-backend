/**
 * One-time CLI script to create a User (admin or viewer) for a brand.
 * Hashes the password with bcrypt before storing - never stores plaintext.
 *
 * Usage:
 *   node createUser.js <email> <password> <brandId> [role] [name]
 *
 * Example:
 *   node createUser.js jane@winkbrowbar.com "SomeStrongPassword123!" 64f1a2b3c4d5e6f7a8b9c0d1 admin "Jane Doe"
 *
 * role defaults to "viewer" if omitted. Must be "admin" or "viewer".
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const { connectDB } = require('./src/db/connection');
const User = require('./src/db/models/User');

const [, , email, password, brandId, roleArg, ...nameParts] = process.argv;
const role = roleArg || 'viewer';
const name = nameParts.join(' ') || undefined;

if (!email || !password || !brandId) {
  console.error('Usage: node createUser.js <email> <password> <brandId> [role] [name]');
  process.exit(1);
}

if (!['admin', 'viewer'].includes(role)) {
  console.error(`Invalid role "${role}". Must be "admin" or "viewer".`);
  process.exit(1);
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

async function run() {
  await connectDB();

  const existing = await User.findOne({ brandId, email: email.toLowerCase().trim() });
  if (existing) {
    console.error(`A user with email "${email}" already exists for this brand (userId: ${existing._id}).`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await User.create({
    brandId,
    email: email.toLowerCase().trim(),
    passwordHash,
    name,
    role,
    isActive: true,
  });

  console.log('User created successfully:');
  console.log({
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
    brandId: user.brandId.toString(),
  });

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Failed to create user:', err);
  process.exit(1);
});