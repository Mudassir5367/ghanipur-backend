import 'dotenv/config';
import { z } from 'zod';

/**
 * Single source of truth for configuration. Nothing else in the app reads
 * process.env directly (§42). Fails fast at boot if required vars are missing.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

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
  OTP_TTL_MIN: z.coerce.number().int().positive().default(10),          // OTP validity
  OTP_RESEND_COOLDOWN_SEC: z.coerce.number().int().positive().default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),      // wrong tries before lockout
  RESET_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),  // window to set the new password
  // Local/dev only: echo the OTP in the API response so testing works without email.
  // MUST be false/unset in production (an OTP in the response defeats the point).
  EXPOSE_OTP: z.enum(['true', 'false']).optional(),

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
