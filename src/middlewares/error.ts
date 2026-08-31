import type { Request, Response, NextFunction } from 'express';
import { UniqueConstraintError } from '../repositories/dynamo/base.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
}

function normalize(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  // A uniqueness guard rejected the write — the DynamoDB equivalent of Mongo's
  // duplicate-key error, kept on the same DUPLICATE_KEY code so clients that
  // already handle it keep working.
  if (err instanceof UniqueConstraintError) {
    return ApiError.conflict(`Duplicate value for ${err.field}`, 'DUPLICATE_KEY');
  }

  // A conditional write that lost a race (e.g. two payments on one delivery).
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException') {
    return ApiError.conflict('The record changed while you were editing it. Please retry.', 'CONFLICT');
  }

  // DynamoDB rejects a malformed key before it reaches our validators.
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'ValidationException') {
    return ApiError.badRequest('Invalid request for this record', 'INVALID_ID');
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
