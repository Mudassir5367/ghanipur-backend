import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

/**
 * One active password-reset per email. The OTP and the post-verification reset
 * token are stored HASHED (never in plaintext), so a DB leak can't be used to
 * reset accounts. Docs self-expire a day after creation via a TTL index.
 */
const passwordResetSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    otpHash: { type: String, required: true },
    resetTokenHash: { type: String, default: null }, // set once the OTP is verified
    expiresAt: { type: Date, required: true }, // OTP validity, then reset-token validity
    attempts: { type: Number, default: 0 }, // wrong OTP entries
    lastSentAt: { type: Date, default: Date.now }, // resend cooldown anchor
    verifiedAt: { type: Date, default: null }, // OTP consumed (prevents re-verify/reuse)
  },
  { timestamps: true },
);

// Auto-clean stale rows so abandoned flows don't accumulate.
passwordResetSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export type PasswordResetDoc = InferSchemaType<typeof passwordResetSchema> & { _id: Types.ObjectId };

export const PasswordReset = model('PasswordReset', passwordResetSchema);
