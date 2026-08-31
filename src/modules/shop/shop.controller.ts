import type { Request, Response } from 'express';
import * as shopService from './shop.service.js';
import { issueTokensForUser } from '../auth/auth.service.js';
import { setRefreshCookie } from '../auth/cookie.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { ShopStatus } from '../../models/shop.model.js';

function tenantShopId(req: Request): string {
  if (!req.tenant) throw ApiError.forbidden('Shop context required', 'NO_SHOP');
  return req.tenant.shopId;
}

// ---- Own shop ----
export const getMyShop = asyncHandler(async (req: Request, res: Response) => {
  const shop = await shopService.getShop(tenantShopId(req));
  ok(res, { shop });
});

export const updateMyShop = asyncHandler(async (req: Request, res: Response) => {
  const shopId = tenantShopId(req);
  const shop = await shopService.updateShop(shopId, req.body);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId, action: 'SHOP_UPDATE', resource: 'Shop', resourceId: shopId, ip: req.ip });
  ok(res, { shop });
});

export const getMySettings = asyncHandler(async (req: Request, res: Response) => {
  const settings = await shopService.getSettings(tenantShopId(req));
  ok(res, { settings });
});

export const updateMySettings = asyncHandler(async (req: Request, res: Response) => {
  const shopId = tenantShopId(req);
  const settings = await shopService.updateSettings(shopId, req.body);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId, action: 'SETTINGS_UPDATE', resource: 'ShopSettings', ip: req.ip });
  ok(res, { settings });
});

// A logged-in shop admin creates their own shop (§2). Re-issues their token
// because the embedded shopId changes.
export const createMyShop = asyncHandler(async (req: Request, res: Response) => {
  const shop = await shopService.createMyShop(req.auth!.userId, req.body);
  const tokens = await issueTokensForUser(req.auth!.userId);
  setRefreshCookie(res, tokens.refreshToken);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: shop.id, action: 'SHOP_SELF_CREATE', resource: 'Shop', resourceId: shop.id, ip: req.ip });
  created(res, { shop, accessToken: tokens.accessToken, user: tokens.user });
});

// ---- Public ----
export const listPublicShops = asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await shopService.listPublicShops(req.query);
  ok(res, data, 200, meta);
});

export const getPublicShop = asyncHandler(async (req: Request, res: Response) => {
  const shop = await shopService.getPublicShopBySlug(req.params.slug!);
  ok(res, { shop });
});

// ---- Super admin ----
export const listShops = asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await shopService.listShops(req.query, req.query.status as ShopStatus | undefined);
  ok(res, data, 200, meta);
});

export const getShop = asyncHandler(async (req: Request, res: Response) => {
  const shop = await shopService.getShopByIdAdmin(req.params.id!);
  ok(res, { shop });
});

export const createShop = asyncHandler(async (req: Request, res: Response) => {
  const shop = await shopService.createShop(req.body);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: shop.id, action: 'SHOP_CREATE', resource: 'Shop', resourceId: shop.id, ip: req.ip });
  created(res, { shop });
});

export const updateShopStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body as { status: ShopStatus };
  const shop = await shopService.setShopStatus(id!, status);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: id, action: `SHOP_STATUS_${status}`, resource: 'Shop', resourceId: id, ip: req.ip });
  ok(res, { shop });
});
