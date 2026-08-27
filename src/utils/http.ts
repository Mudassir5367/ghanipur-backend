import type { Request, Response, NextFunction, RequestHandler } from 'express';

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Consistent success envelope (§33). */
export function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): Response {
  return res.status(status).json(meta ? { success: true, data, meta } : { success: true, data });
}

export function created<T>(res: Response, data: T): Response {
  return ok(res, data, 201);
}

export function paginated<T>(res: Response, data: T[], meta: PageMeta): Response {
  return ok(res, data, 200, meta);
}

export function buildPageMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

/** Wrap async handlers so thrown/rejected errors reach the error middleware. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
