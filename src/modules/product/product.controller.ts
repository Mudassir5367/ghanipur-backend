import type { Request, Response } from 'express';
import * as service from './product.service.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { TenantContext } from '../../types/context.js';

function ctx(req: Request): TenantContext {
  if (!req.tenant) throw ApiError.forbidden('Shop context required', 'NO_SHOP');
  return req.tenant;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await service.listProducts(ctx(req), req.query, {
    categoryId: req.query.categoryId as string | undefined,
    status: req.query.status as string | undefined,
    isAvailable: req.query.isAvailable as string | undefined,
    lowStock: req.query.lowStock as string | undefined,
  });
  ok(res, data, 200, meta);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const product = await service.getProduct(ctx(req), req.params.id!);
  ok(res, { product });
});

export const suggestSku = asyncHandler(async (req: Request, res: Response) => {
  const sku = await service.suggestSku(ctx(req), req.query.categoryId as string | undefined);
  ok(res, { sku });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const product = await service.createProduct(ctx(req), req.body, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'PRODUCT_CREATE', resource: 'Product', resourceId: product._id.toString(), ip: req.ip });
  created(res, { product });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const product = await service.updateProduct(ctx(req), req.params.id!, req.body);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'PRODUCT_UPDATE', resource: 'Product', resourceId: req.params.id, ip: req.ip });
  ok(res, { product });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await service.deleteProduct(ctx(req), req.params.id!, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'PRODUCT_DELETE', resource: 'Product', resourceId: req.params.id, ip: req.ip });
  ok(res, { message: 'Product archived' });
});

export const recordInventory = asyncHandler(async (req: Request, res: Response) => {
  const result = await service.recordInventoryMovement(ctx(req), req.params.id!, req.body, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: `INVENTORY_${req.body.type}`, resource: 'Product', resourceId: req.params.id, ip: req.ip, metadata: { quantity: req.body.quantity } });
  ok(res, result);
});

export const ledger = asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await service.getProductLedger(ctx(req), req.params.id!, req.query);
  ok(res, data, 200, meta);
});
