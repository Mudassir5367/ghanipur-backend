import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/token.service.js';
import { ApiError } from '../utils/ApiError.js';
import type { Permission } from '../constants/permissions.js';
import { Role } from '../constants/roles.js';
import * as shopRepo from '../repositories/dynamo/shopRepository.js';
import { ShopStatus } from '../repositories/dynamo/shopRepository.js';
import * as userRepo from '../repositories/dynamo/userRepository.js';
import { clearRefreshCookie } from '../modules/auth/cookie.js';

/**
 * Verifies the Bearer access token and attaches req.auth. The token itself carries
 * role + effective permissions (issued at login).
 *
 * Shop admins/staff are additionally checked against their shop's live status on
 * EVERY request, so a shop suspended by the super admin mid-session is logged out
 * on its very next call (not only on shop-scoped routes or at token refresh): the
 * refresh session is revoked and 403 SHOP_SUSPENDED is returned.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    return next(ApiError.unauthorized('Authentication required', 'NO_TOKEN'));
  }
  try {
    const payload = verifyAccessToken(token);
    req.auth = {
      userId: payload.sub,
      role: payload.role,
      shopId: payload.shopId,
      permissions: (payload.perms ?? []) as Permission[],
    };
  } catch {
    return next(ApiError.unauthorized('Invalid or expired token', 'INVALID_TOKEN'));
  }

  const { role, shopId, userId } = req.auth;
  if ((role === Role.SHOP_ADMIN || role === Role.SHOP_STAFF) && shopId) {
    try {
      const shop = await shopRepo.findById(shopId);
      if (!shop || shop.status === ShopStatus.SUSPENDED || shop.status === ShopStatus.INACTIVE) {
        // End the session server-side too (read first: an update would upsert a missing user).
        const user = await userRepo.findById(userId);
        if (user?.refreshTokenHash) await userRepo.setRefreshTokenHash(userId, null);
        clearRefreshCookie(res);
        return next(ApiError.forbidden('This shop has been suspended. Please contact the platform administrator.', 'SHOP_SUSPENDED'));
      }
    } catch (err) {
      return next(err);
    }
  }
  next();
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
