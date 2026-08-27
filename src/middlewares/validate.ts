import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { ApiError } from '../utils/ApiError.js';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Backend validation is mandatory (§55). Parses and REPLACES req parts with the
 * typed, coerced result so controllers receive clean data.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) Object.assign(req.query, schemas.query.parse(req.query));
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const errors = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        throw ApiError.badRequest('Validation failed', 'VALIDATION_ERROR', errors);
      }
      throw err;
    }
  };
}
