import type { Request, Response } from 'express';
import * as service from './category.service.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { TenantContext } from '../../types/context.js';

function ctx(req: Request): TenantContext {
  if (!req.tenant) throw ApiError.forbidden('Shop context required', 'NO_SHOP');
  return req.tenant;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await service.listCategories(ctx(req), req.query, {
    status: req.query.status as string | undefined,
    parentId: req.query.parentId as string | undefined,
  });
  ok(res, data, 200, meta);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const category = await service.getCategory(ctx(req), req.params.id!);
  ok(res, { category });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const category = await service.createCategory(ctx(req), req.body);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'CATEGORY_CREATE', resource: 'Category', resourceId: category.id, ip: req.ip });
  created(res, { category });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const category = await service.updateCategory(ctx(req), req.params.id!, req.body);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'CATEGORY_UPDATE', resource: 'Category', resourceId: req.params.id, ip: req.ip });
  ok(res, { category });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await service.deleteCategory(ctx(req), req.params.id!, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'CATEGORY_DELETE', resource: 'Category', resourceId: req.params.id, ip: req.ip });
  ok(res, { message: 'Category deleted' });
});
