import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError.js';
import { Role } from '../constants/roles.js';
import type { Permission } from '../constants/permissions.js';

/**
 * Reusable permission gate (§31). SUPER_ADMIN passes everything. All listed
 * permissions must be present (AND). Use once per route — no ad-hoc checks.
 */
export function authorize(...required: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (!auth) throw ApiError.unauthorized('Authentication required', 'NO_TOKEN');
    if (auth.role === Role.SUPER_ADMIN) return next();

    const missing = required.filter((p) => !auth.permissions.includes(p));
    if (missing.length > 0) {
      throw ApiError.forbidden('Insufficient permissions', 'FORBIDDEN');
    }
    next();
  };
}

/** Restrict a route to specific roles regardless of permissions. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (!auth) throw ApiError.unauthorized('Authentication required', 'NO_TOKEN');
    if (!roles.includes(auth.role)) {
      throw ApiError.forbidden('Insufficient role', 'FORBIDDEN');
    }
    next();
  };
}
