import express, { type Express } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoSanitize from 'express-mongo-sanitize';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { apiV1 } from './routes/index.js';
import { healthRouter } from './modules/health/health.routes.js';
import { uploadDir } from './modules/upload/upload.routes.js';
import { errorHandler, notFound } from './middlewares/error.js';
import { ApiError } from './utils/ApiError.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1); // correct req.ip behind a load balancer (§70)

  // Security headers (§32)
  app.use(helmet());

  // Gzip responses (§35)
  app.use(compression());

  // CORS allowlist with credentials for the refresh cookie
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        return cb(new ApiError(403, 'Origin not allowed', 'CORS_BLOCKED'));
      },
      credentials: true,
    }),
  );

  // Body limits (§32)
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  // NoSQL injection protection (§32)
  app.use(mongoSanitize());

  // Request id + structured logging (§72)
  app.use((req, _res, next) => {
    req.id = (req.headers['x-request-id'] as string) || randomUUID();
    next();
  });
  app.use(pinoHttp({ logger, genReqId: (req) => (req as { id?: string }).id ?? randomUUID() }));

  // Global rate limit (auth routes have a tighter one of their own)
  app.use(
    '/api',
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.use('/health', healthRouter);
  // Uploaded images (product photos, avatars) — public, cacheable, and loadable
  // cross-origin (the browser page is on a different port than the API).
  app.use(
    '/uploads',
    express.static(uploadDir, {
      maxAge: '7d',
      immutable: true,
      setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
    }),
  );
  app.use('/api/v1', apiV1);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
