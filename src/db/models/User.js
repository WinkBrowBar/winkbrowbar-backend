const { Schema, model } = require('mongoose');

const userSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  name: String,
  // admin: full dashboard + can create/manage other users
  // viewer: read-only dashboard access, cannot manage users
  role: { type: String, enum: ['admin', 'viewer'], default: 'viewer' },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

userSchema.index({ brandId: 1, email: 1 }, { unique: true });

module.exports = model('User', userSchema);
