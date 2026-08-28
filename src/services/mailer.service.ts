import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

let transporter: Transporter | null = null;
function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
}

/**
 * Sends the password-reset OTP to the user's registered email via SMTP when it's
 * configured (SMTP_HOST/USER/PASS). Without SMTP it logs the code (dev). Deliverability
 * to the inbox (vs spam) depends on the sending provider/domain (SPF/DKIM/DMARC) and a
 * trustworthy From address — configure a real transactional sender for production.
 */
export async function sendOtpEmail(email: string, otp: string): Promise<void> {
  const tx = getTransporter();
  if (!tx) {
    logger.info({ email, kind: 'password-reset-otp' }, `Password reset OTP for ${email}: ${otp} (SMTP not configured — logging only)`);
    return;
  }
  const from = env.SMTP_FROM || env.SMTP_USER!;
  const minutes = env.OTP_TTL_MIN;
  try {
    await tx.sendMail({
      from,
      to: email,
      subject: `Your Ghanipur verification code: ${otp}`,
      text: `Your Ghanipur password reset code is ${otp}. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}. If you didn't request this, ignore this email.`,
      html: `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#15803d">Ghanipur</h2>
          <p>Your password reset code is:</p>
          <p style="font-size:30px;font-weight:bold;letter-spacing:6px;color:#111">${otp}</p>
          <p style="color:#555">It expires in ${minutes} minute${minutes === 1 ? '' : 's'}. If you didn't request this, you can safely ignore this email.</p>
        </div>`,
    });
    logger.info({ email }, 'Password reset OTP email sent');
  } catch (err) {
    logger.error({ err, email }, 'Failed to send OTP email');
    throw err;
  }
}
