import type { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
}

function normalize(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  // Mongo duplicate key
  if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
    const key = Object.keys((err as { keyValue?: Record<string, unknown> }).keyValue ?? {})[0] ?? 'field';
    return ApiError.conflict(`Duplicate value for ${key}`, 'DUPLICATE_KEY');
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const errors = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    return ApiError.badRequest('Validation failed', 'VALIDATION_ERROR', errors);
  }
  if (err instanceof mongoose.Error.CastError) {
    return ApiError.badRequest(`Invalid ${err.path}`, 'INVALID_ID');
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  const apiErr = ApiError.internal(message);
  (apiErr as { isOperational: boolean }).isOperational = false;
  return apiErr;
}

/** Centralized error handler (§39). No stack traces leak in production. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const apiErr = normalize(err);

  const logPayload = { err, reqId: req.id, code: apiErr.code, path: req.originalUrl };
  if (apiErr.statusCode >= 500) logger.error(logPayload, apiErr.message);
  else logger.warn(logPayload, apiErr.message);

  const body: Record<string, unknown> = {
    success: false,
    message: apiErr.isOperational || !env.isProd ? apiErr.message : 'Internal server error',
    code: apiErr.code,
  };
  if (apiErr.errors.length > 0) body.errors = apiErr.errors;
  if (!env.isProd && apiErr.statusCode >= 500) body.stack = apiErr.stack;

  res.status(apiErr.statusCode).json(body);
}
