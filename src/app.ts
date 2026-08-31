import express, { type Express } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { apiV1 } from './routes/index.js';
import { healthRouter } from './modules/health/health.routes.js';
import { getObject, isSafeKey } from './config/storage.js';
import { errorHandler, notFound } from './middlewares/error.js';
import { ApiError } from './utils/ApiError.js';
import { asyncHandler } from './utils/http.js';

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

  // The NoSQL-injection sanitiser (§32) stripped `$`/`.` keys that Mongo would
  // have interpreted as query operators. DynamoDB has no query language in the
  // data path — every read is a typed Query/GetItem against named keys, and user
  // input is bound as values, never parsed as an expression — so that class of
  // injection no longer exists here. Zod still validates every request body.

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
  /**
   * Uploaded images (product photos, avatars) — public, cacheable, and loadable
   * cross-origin (the browser page is on a different port than the API).
   *
   * Streamed from private S3 rather than served off disk, so the bucket stays
   * closed to the internet and the URL stays same-origin. Keys embed a UUID and
   * an object never changes under a key, so these are safe to cache immutably.
   */
  app.get('/uploads/:key', asyncHandler(async (req, res) => {
    const key = req.params.key ?? '';
    if (!isSafeKey(key)) throw ApiError.badRequest('Invalid image reference', 'INVALID_KEY');

    const object = await getObject(key);
    if (!object) throw ApiError.notFound('Image not found', 'IMAGE_NOT_FOUND');

    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    if (object.contentType) res.setHeader('Content-Type', object.contentType);
    if (object.contentLength !== undefined) res.setHeader('Content-Length', String(object.contentLength));
    object.stream.pipe(res);
  }));
  app.use('/api/v1', apiV1);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
