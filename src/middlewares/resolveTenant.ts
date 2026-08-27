import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError.js';
import { Role } from '../constants/roles.js';
import { Shop, ShopStatus } from '../models/shop.model.js';
import { recordAudit } from '../services/audit.service.js';

/**
 * Establishes the shop tenant the request operates within (§22). This is the
 * ONLY place a shopId enters a shop-scoped request; repositories read it from
 * req.tenant. Frontend input can never widen a shop user's scope.
 *
 * - SHOP_ADMIN / SHOP_STAFF: locked to their own shopId; a suspended/inactive shop
 *   is blocked in real time (not just at login).
 * - SUPER_ADMIN: must target a shop via `x-shop-id` header (audited as impersonation);
 *   can still reach suspended shops in order to manage them.
 */
export async function resolveTenant(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = req.auth;
    if (!auth) throw ApiError.unauthorized('Authentication required', 'NO_TOKEN');

    if (auth.role === Role.SHOP_ADMIN || auth.role === Role.SHOP_STAFF) {
      if (!auth.shopId) throw ApiError.forbidden('User is not attached to a shop', 'NO_SHOP');
      const shop = await Shop.findById(auth.shopId, 'status isDeleted').lean();
      if (!shop || shop.isDeleted || shop.status === ShopStatus.SUSPENDED || shop.status === ShopStatus.INACTIVE) {
        throw ApiError.forbidden('This shop has been suspended. Please contact the platform administrator.', 'SHOP_SUSPENDED');
      }
      req.tenant = { shopId: auth.shopId, impersonated: false };
      return next();
    }

    if (auth.role === Role.SUPER_ADMIN) {
      const target = (req.header('x-shop-id') || req.query.shopId) as string | undefined;
      if (!target) {
        throw ApiError.badRequest('Super admin must specify a target shop (x-shop-id)', 'SHOP_REQUIRED');
      }
      req.tenant = { shopId: target, impersonated: true };
      void recordAudit({
        actorId: auth.userId,
        actorRole: auth.role,
        shopId: target,
        action: 'IMPERSONATE_SHOP',
        ip: req.ip,
        metadata: { method: req.method, path: req.originalUrl },
      });
      return next();
    }

    throw ApiError.forbidden('This resource requires a shop context', 'NO_SHOP');
  } catch (err) {
    next(err);
  }
}
