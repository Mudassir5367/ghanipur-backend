import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

/**
 * Transactional email, with three modes tried in order:
 *
 *  1. Amazon SES (SES_FROM set) — preferred. Uses the EC2 instance role, so
 *     there are no mail credentials in the environment at all, matching how
 *     DynamoDB and S3 are reached.
 *  2. SMTP (SMTP_HOST/USER/PASS set) — kept so any provider still works, and so
 *     nothing breaks for anyone already configured that way.
 *  3. Log only — development, where no mail is actually sent.
 *
 * SES caveat worth knowing: a new account is in the SES sandbox, which can only
 * deliver to VERIFIED addresses. Password reset needs to reach arbitrary
 * customers, so production access must be requested before real users — until
 * then a reset to an unverified address fails, and this logs it as such rather
 * than pretending it was delivered.
 */

let ses: SESv2Client | null = null;
function getSes(): SESv2Client | null {
  if (!env.SES_FROM) return null;
  // No explicit credentials: the instance role is resolved by the default chain.
  ses ??= new SESv2Client({ region: env.SES_REGION ?? env.AWS_REGION });
  return ses;
}

let transporter: Transporter | null = null;
function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return transporter;
}

interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
}

async function sendViaSes(client: SESv2Client, msg: Message): Promise<void> {
  await client.send(
    new SendEmailCommand({
      FromEmailAddress: env.SES_FROM!,
      Destination: { ToAddresses: [msg.to] },
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: msg.text, Charset: 'UTF-8' },
            Html: { Data: msg.html, Charset: 'UTF-8' },
          },
        },
      },
    }),
  );
}

function otpMessage(email: string, otp: string): Message {
  const minutes = env.OTP_TTL_MIN;
  const expiry = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return {
    to: email,
    subject: `Your Ghanipur verification code: ${otp}`,
    text: `Your Ghanipur password reset code is ${otp}. It expires in ${expiry}. If you didn't request this, ignore this email.`,
    html: `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#15803d">Ghanipur</h2>
          <p>Your password reset code is:</p>
          <p style="font-size:30px;font-weight:bold;letter-spacing:6px;color:#111">${otp}</p>
          <p style="color:#555">It expires in ${expiry}. If you didn't request this, you can safely ignore this email.</p>
        </div>`,
  };
}

/**
 * Sends the password-reset OTP to the user's registered email.
 *
 * Deliverability to the inbox (vs spam) depends on the sending domain's SPF/DKIM
 * — with SES, verifying a domain identity sets those up and is what makes these
 * land reliably. A verified single address works but is weaker.
 */
export async function sendOtpEmail(email: string, otp: string): Promise<void> {
  const msg = otpMessage(email, otp);

  const sesClient = getSes();
  if (sesClient) {
    try {
      await sendViaSes(sesClient, msg);
      logger.info({ email, via: 'ses' }, 'Password reset OTP email sent');
      return;
    } catch (err) {
      const name = (err as { name?: string }).name;
      // The sandbox rejects unverified recipients. Say so explicitly — this is
      // the failure people hit first and the message is otherwise cryptic.
      if (name === 'MessageRejected' || name === 'AccountSuspendedException') {
        logger.error(
          { err, email },
          'SES rejected the message. If the account is still in the SES sandbox, the recipient address must be verified — request production access to email arbitrary users.',
        );
      } else {
        logger.error({ err, email }, 'Failed to send OTP email via SES');
      }
      throw err;
    }
  }

  const tx = getTransporter();
  if (tx) {
    try {
      await tx.sendMail({ from: env.SMTP_FROM || env.SMTP_USER!, ...msg });
      logger.info({ email, via: 'smtp' }, 'Password reset OTP email sent');
    } catch (err) {
      logger.error({ err, email }, 'Failed to send OTP email via SMTP');
      throw err;
    }
    return;
  }

  logger.info(
    { email, kind: 'password-reset-otp' },
    `Password reset OTP for ${email}: ${otp} (no mail transport configured — logging only)`,
  );
}
