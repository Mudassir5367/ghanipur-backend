import 'dotenv/config';
import { z } from 'zod';

/**
 * Single source of truth for configuration. Nothing else in the app reads
 * process.env directly (§42). Fails fast at boot if required vars are missing.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  // Transitional: still required while Mongoose modules are being ported to
  // DynamoDB (§ migration plan). Removed once the port is complete.
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

  // DynamoDB. No AWS_ACCESS_KEY_ID/SECRET in production — the EC2 instance role
  // is used instead (SDK default credential chain resolves it automatically).
  AWS_REGION: z.string().min(1).default('ap-south-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  DYNAMO_ENDPOINT: z.string().url().optional(), // local dynamodb-local override
  DYNAMO_TABLE_PREFIX: z.string().default(''),  // e.g. "ghanipur_" for env isolation

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be >=16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be >=16 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('7d'),
  REFRESH_TOKEN_TTL_MS: z.coerce.number().int().positive().default(7 * 24 * 60 * 60 * 1000),

  // Comma-separated allowlist of origins for CORS (§32).
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  APP_URL: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://localhost:5000'),

  COOKIE_DOMAIN: z.string().optional(),
  // Force the refresh cookie's Secure/SameSite mode. Left unset, it follows the
  // APP_URL scheme: https -> Secure+SameSite=None, http -> insecure+Lax. This is
  // what lets the http://localhost Docker stack persist sessions (a Secure cookie
  // is silently dropped by browsers over plain http). Set 'true' behind real TLS.
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),

  // Static header keys (x-setup-key) that authorize provisioning without a token.
  SUPER_ADMIN_SETUP_KEY: z.string().min(8).optional(), // create a super admin
  ADMIN_SETUP_KEY: z.string().min(8).optional(),       // create a shop admin

  // Password-reset OTP flow.
  OTP_TTL_MIN: z.coerce.number().int().positive().default(2),           // OTP validity (minutes)
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(4),         // number of digits
  OTP_RESEND_COOLDOWN_SEC: z.coerce.number().int().positive().default(120),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),      // wrong tries before lockout
  RESET_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),  // window to set the new password
  // Local/dev only: echo the OTP in the API response so testing works without email.
  // MUST be false/unset in production (an OTP in the response defeats the point).
  // Empty string (from docker-compose ${VAR:-}) is treated as unset.
  EXPOSE_OTP: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).optional()),

  // SMTP for sending real OTP emails (leave unset to log the OTP instead).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).optional()), // true for port 465
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(), // e.g. "Ghanipur <no-reply@yourdomain.com>"

  // Where uploaded product images are served from (absolute URLs stored in DB).
  UPLOAD_DIR: z.string().default('uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const raw = parsed.data;

// Cookie security follows the app scheme unless explicitly overridden, so the
// same production image works over http://localhost (dev/Docker) and https (prod).
const cookieSecure = raw.COOKIE_SECURE
  ? raw.COOKIE_SECURE === 'true'
  : raw.APP_URL.startsWith('https://');

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  isDev: raw.NODE_ENV === 'development',
  cookieSecure,
  exposeOtp: raw.EXPOSE_OTP === 'true',
  corsOrigins: raw.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
} as const;

export type Env = typeof env;
