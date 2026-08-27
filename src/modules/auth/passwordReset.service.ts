import crypto from 'node:crypto';
import { User } from '../../models/user.model.js';
import { PasswordReset } from '../../models/passwordReset.model.js';
import { hashPassword, hashToken, verifyTokenHash } from '../../services/token.service.js';
import { sendOtpEmail } from '../../services/mailer.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { env } from '../../config/env.js';

const normalize = (email: string) => email.toLowerCase().trim();
const genOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); // 000000–999999
const genResetToken = () => crypto.randomBytes(32).toString('hex');

/**
 * Step 1 — request a reset code. ALWAYS resolves the same way regardless of whether
 * the email exists (anti-enumeration); the caller returns one generic message. A
 * code is only generated/sent for a real, active account, and only if the resend
 * cooldown has elapsed. Returns the OTP only when EXPOSE_OTP is on (local testing).
 */
export async function requestPasswordReset(emailRaw: string): Promise<{ devOtp?: string }> {
  const email = normalize(emailRaw);
  const user = await User.findOne({ email });
  if (!user || !user.isActive) return {}; // stay silent — do not reveal (non-)existence

  // Resend cooldown: if a live (unverified) code was sent very recently, don't resend.
  const existing = await PasswordReset.findOne({ email, verifiedAt: null });
  if (existing && Date.now() - existing.lastSentAt.getTime() < env.OTP_RESEND_COOLDOWN_SEC * 1000) {
    return {};
  }

  const otp = genOtp();
  await PasswordReset.findOneAndUpdate(
    { email },
    {
      email,
      otpHash: await hashToken(otp),
      resetTokenHash: null,
      verifiedAt: null,
      attempts: 0,
      expiresAt: new Date(Date.now() + env.OTP_TTL_MIN * 60_000),
      lastSentAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await sendOtpEmail(email, otp);
  return env.exposeOtp ? { devOtp: otp } : {};
}

/**
 * Step 2 — verify the OTP. Enforces expiry, a per-code attempt limit, and single
 * use. On success issues a one-time reset token (the only thing that authorizes the
 * password change) and marks the OTP consumed so it can never be verified again.
 */
export async function verifyOtp(emailRaw: string, otp: string): Promise<{ resetToken: string }> {
  const email = normalize(emailRaw);
  const pr = await PasswordReset.findOne({ email });
  const invalid = ApiError.badRequest('Invalid or expired code. Please request a new one.', 'OTP_INVALID');

  // Same generic error whether there's no request, it's expired, or already used —
  // never leak which. (Distinct code only for the "attempts left" nudge below.)
  if (!pr || pr.verifiedAt) throw invalid;
  if (pr.expiresAt.getTime() < Date.now()) { await pr.deleteOne(); throw invalid; }
  if (pr.attempts >= env.OTP_MAX_ATTEMPTS) { await pr.deleteOne(); throw ApiError.badRequest('Too many incorrect attempts. Please request a new code.', 'OTP_LOCKED'); }

  const ok = await verifyTokenHash(pr.otpHash, otp);
  if (!ok) {
    pr.attempts += 1;
    const left = env.OTP_MAX_ATTEMPTS - pr.attempts;
    if (left <= 0) { await pr.deleteOne(); throw ApiError.badRequest('Too many incorrect attempts. Please request a new code.', 'OTP_LOCKED'); }
    await pr.save();
    throw ApiError.badRequest(`Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.`, 'OTP_INCORRECT');
  }

  const resetToken = genResetToken();
  pr.resetTokenHash = await hashToken(resetToken);
  pr.verifiedAt = new Date(); // OTP is now consumed — cannot be verified again
  pr.expiresAt = new Date(Date.now() + env.RESET_TOKEN_TTL_MIN * 60_000); // window to set the new password
  await pr.save();
  return { resetToken };
}

/**
 * Step 3 — set the new password using the one-time reset token from step 2. On
 * success the password is re-hashed (argon2), all existing sessions are revoked,
 * and the reset row is deleted so the token can never be reused.
 */
export async function resetPassword(emailRaw: string, resetToken: string, newPassword: string): Promise<void> {
  const email = normalize(emailRaw);
  const pr = await PasswordReset.findOne({ email, verifiedAt: { $ne: null } });
  const invalid = ApiError.badRequest('Reset session is invalid or has expired. Please start again.', 'RESET_INVALID');
  if (!pr || !pr.resetTokenHash) throw invalid;
  if (pr.expiresAt.getTime() < Date.now()) { await pr.deleteOne(); throw invalid; }

  const ok = await verifyTokenHash(pr.resetTokenHash, resetToken);
  if (!ok) throw invalid;

  const user = await User.findOne({ email });
  if (!user) { await pr.deleteOne(); throw invalid; }

  user.passwordHash = await hashPassword(newPassword);
  user.refreshTokenHash = null; // revoke every existing session after a password change
  await user.save();

  await pr.deleteOne(); // single-use: the reset token/OTP can never be reused
}
