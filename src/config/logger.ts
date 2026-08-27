import pino from 'pino';
import { env } from './env.js';

/**
 * Structured logging (§72). Pretty in dev, JSON in prod. Never log secrets:
 * redaction covers common sensitive fields.
 */
const redact = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    '*.password',
    '*.passwordHash',
    '*.refreshToken',
    '*.refreshTokenHash',
    '*.token',
  ],
  remove: true,
};

// Pretty logs in dev, but only if pino-pretty is actually installed (it's a
// devDependency, pruned from production images). Falls back to JSON otherwise,
// so a prod build never crashes on a missing transport.
function buildLogger() {
  const base = { level: env.LOG_LEVEL, redact };
  if (env.isProd) return pino(base);
  try {
    return pino({ ...base, transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } });
  } catch {
    return pino(base);
  }
}

export const logger = buildLogger();
