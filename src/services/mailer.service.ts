import { logger } from '../config/logger.js';

/**
 * Sends the password-reset OTP to the user's registered email.
 *
 * There is no SMTP provider wired in this environment, so for local/dev the code
 * is written to the server log (retrievable via `docker compose logs backend`),
 * and — when EXPOSE_OTP=true — also returned in the API response by the caller.
 *
 * To send real email in production, plug a provider here (e.g. nodemailer with
 * SMTP creds, or an API like SES/Resend) and turn EXPOSE_OTP off. The rest of the
 * reset flow is unchanged.
 */
export async function sendOtpEmail(email: string, otp: string): Promise<void> {
  logger.info({ email, kind: 'password-reset-otp' }, `Password reset OTP for ${email}: ${otp}`);
}
