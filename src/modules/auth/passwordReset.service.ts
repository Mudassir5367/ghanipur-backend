import crypto from 'node:crypto';
import * as userRepo from '../../repositories/dynamo/userRepository.js';
import { passwordResets } from '../../repositories/dynamo/miscRepositories.js';
import { hashPassword, hashToken, verifyTokenHash } from '../../services/token.service.js';
import { sendOtpEmail } from '../../services/mailer.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { env } from '../../config/env.js';

const normalize = (email: string) => email.toLowerCase().trim();
const genOtp = () => String(crypto.randomInt(0, 10 ** env.OTP_LENGTH)).padStart(env.OTP_LENGTH, '0');
const genResetToken = () => crypto.randomBytes(32).toString('hex');

/**
 * Step 1 — request a reset code. ALWAYS resolves the same way regardless of whether
 * the email exists (anti-enumeration); the caller returns one generic message. A
 * code is only generated/sent for a real, active account, and only if the resend
 * cooldown has elapsed. Returns the OTP only when EXPOSE_OTP is on (local testing).
 *
 * One row per email, keyed on the address itself, so "one active reset per email"
 * is the primary key rather than a unique index. Rows self-expire through
 * DynamoDB's native TTL, replacing the Mongo TTL index.
 */
export async function requestPasswordReset(emailRaw: string): Promise<{ devOtp?: string }> {
  const email = normalize(emailRaw);
  const user = await userRepo.findByEmail(email);
  if (!user || !user.isActive) return {}; // stay silent — do not reveal (non-)existence

  // Resend cooldown: if a live (unverified) code was sent very recently, don't resend.
  const existing = await passwordResets.find(email);
  if (
    existing &&
    !existing.verifiedAt &&
    Date.now() - new Date(existing.lastSentAt).getTime() < env.OTP_RESEND_COOLDOWN_SEC * 1000
  ) {
    return {};
  }

  const otp = genOtp();
  await passwordResets.upsert(email, {
    otpHash: await hashToken(otp),
    resetTokenHash: null,
    verifiedAt: null,
    attempts: 0,
    expiresAt: new Date(Date.now() + env.OTP_TTL_MIN * 60_000).toISOString(),
    lastSentAt: new Date().toISOString(),
  });

  // Local/dev (EXPOSE_OTP=true): surface the code in the response and skip email.
  // Live (EXPOSE_OTP unset/false): send the real email, never expose the code.
  if (env.exposeOtp) return { devOtp: otp };
  await sendOtpEmail(email, otp);
  return {};
}

/**
 * Step 2 — verify the OTP. Enforces expiry, a per-code attempt limit, and single
 * use. On success issues a one-time reset token (the only thing that authorizes the
 * password change) and marks the OTP consumed so it can never be verified again.
 */
export async function verifyOtp(emailRaw: string, otp: string): Promise<{ resetToken: string }> {
  const email = normalize(emailRaw);
  const pr = await passwordResets.find(email);
  const invalid = ApiError.badRequest('Invalid or expired code. Please request a new one.', 'OTP_INVALID');

  // Same generic error whether there's no request, it's expired, or already used —
  // never leak which. (Distinct code only for the "attempts left" nudge below.)
  if (!pr || pr.verifiedAt) throw invalid;
  if (new Date(pr.expiresAt).getTime() < Date.now()) {
    await passwordResets.remove(email);
    throw invalid;
  }
  if (pr.attempts >= env.OTP_MAX_ATTEMPTS) {
    await passwordResets.remove(email);
    throw ApiError.badRequest('Too many incorrect attempts. Please request a new code.', 'OTP_LOCKED');
  }

  const ok = await verifyTokenHash(pr.otpHash, otp);
  if (!ok) {
    const attempts = pr.attempts + 1;
    const left = env.OTP_MAX_ATTEMPTS - attempts;
    if (left <= 0) {
      await passwordResets.remove(email);
      throw ApiError.badRequest('Too many incorrect attempts. Please request a new code.', 'OTP_LOCKED');
    }
    await passwordResets.patch(email, { attempts });
    throw ApiError.badRequest(`Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.`, 'OTP_INCORRECT');
  }

  const resetToken = genResetToken();
  await passwordResets.patch(email, {
    resetTokenHash: await hashToken(resetToken),
    verifiedAt: new Date().toISOString(), // OTP is now consumed — cannot be verified again
    expiresAt: new Date(Date.now() + env.RESET_TOKEN_TTL_MIN * 60_000).toISOString(), // window to set the new password
  });
  return { resetToken };
}

/**
 * Step 3 — set the new password using the one-time reset token from step 2. On
 * success the password is re-hashed (argon2), all existing sessions are revoked,
 * and the reset row is deleted so the token can never be reused.
 */
export async function resetPassword(emailRaw: string, resetToken: string, newPassword: string): Promise<void> {
  const email = normalize(emailRaw);
  const pr = await passwordResets.find(email);
  const invalid = ApiError.badRequest('Reset session is invalid or has expired. Please start again.', 'RESET_INVALID');
  if (!pr || !pr.verifiedAt || !pr.resetTokenHash) throw invalid;
  if (new Date(pr.expiresAt).getTime() < Date.now()) {
    await passwordResets.remove(email);
    throw invalid;
  }

  const ok = await verifyTokenHash(pr.resetTokenHash, resetToken);
  if (!ok) throw invalid;

  const user = await userRepo.findByEmail(email);
  if (!user) {
    await passwordResets.remove(email);
    throw invalid;
  }

  await userRepo.update(user.id, {
    passwordHash: await hashPassword(newPassword),
    refreshTokenHash: null, // revoke every existing session after a password change
  });

  await passwordResets.remove(email); // single-use: the reset token/OTP can never be reused
}
