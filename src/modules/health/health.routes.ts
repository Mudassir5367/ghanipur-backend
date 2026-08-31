import { Router } from 'express';
import { pingDatabase } from '../../config/dynamo.js';
import { ok } from '../../utils/http.js';

export const healthRouter = Router();

// Liveness: process is up.
healthRouter.get('/', (_req, res) => {
  ok(res, { status: 'ok', uptime: process.uptime() });
});

/**
 * Readiness: the datastore is reachable (§72).
 *
 * Mongoose exposed a cached connection state; DynamoDB is stateless HTTP, so
 * readiness is an actual DescribeTable round trip. `readyState` is kept in the
 * response (1 up / 0 down) because orchestrator probes and the frontend already
 * read that shape.
 */
healthRouter.get('/ready', async (_req, res) => {
  let dbOk = true;
  try {
    await pingDatabase({ strict: true });
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    success: dbOk,
    data: { db: dbOk ? 'up' : 'down', readyState: dbOk ? 1 : 0 },
  });
});
