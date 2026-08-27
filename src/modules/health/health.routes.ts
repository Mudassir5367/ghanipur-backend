import { Router } from 'express';
import mongoose from 'mongoose';
import { ok } from '../../utils/http.js';

export const healthRouter = Router();

// Liveness: process is up.
healthRouter.get('/', (_req, res) => {
  ok(res, { status: 'ok', uptime: process.uptime() });
});

// Readiness: dependencies (DB) are reachable (§72).
healthRouter.get('/ready', async (_req, res) => {
  const state = mongoose.connection.readyState; // 1 = connected
  const dbOk = state === 1;
  res.status(dbOk ? 200 : 503).json({
    success: dbOk,
    data: { db: dbOk ? 'up' : 'down', readyState: state },
  });
});
