import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/token.service.js';
import { ApiError } from '../utils/ApiError.js';
import type { Permission } from '../constants/permissions.js';

/**
 * Verifies the Bearer access token and attaches req.auth. Stateless — no DB hit.
 * The token itself carries role + effective permissions (issued at login).
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    throw ApiError.unauthorized('Authentication required', 'NO_TOKEN');
  }
  try {
    const payload = verifyAccessToken(token);
    req.auth = {
      userId: payload.sub,
      role: payload.role,
      shopId: payload.shopId,
      permissions: (payload.perms ?? []) as Permission[],
    };
    next();
  } catch {
    throw ApiError.unauthorized('Invalid or expired token', 'INVALID_TOKEN');
  }
}

/** Optional auth: attaches req.auth if a valid token is present, else continues. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (token) {
    try {
      const payload = verifyAccessToken(token);
      req.auth = {
        userId: payload.sub,
        role: payload.role,
        shopId: payload.shopId,
        permissions: (payload.perms ?? []) as Permission[],
      };
    } catch {
      /* ignore invalid token for public routes */
    }
  }
  next();
}
