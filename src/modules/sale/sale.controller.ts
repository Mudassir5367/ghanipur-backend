import type { Request, Response } from 'express';
import * as service from './sale.service.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { TenantContext } from '../../types/context.js';

function ctx(req: Request): TenantContext {
  if (!req.tenant) throw ApiError.forbidden('Shop context required', 'NO_SHOP');
  return req.tenant;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await service.listSales(ctx(req), req.query, {
    type: req.query.type as string | undefined,
    status: req.query.status as string | undefined,
    customerId: req.query.customerId as string | undefined,
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
  });
  ok(res, data, 200, meta);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const { sale, items } = await service.getSale(ctx(req), req.params.id!);
  ok(res, { sale, items });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const sale = await service.createSale(ctx(req), req.body, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'SALE_CREATE', resource: 'Sale', resourceId: sale._id.toString(), ip: req.ip, metadata: { type: sale.type, totalMinor: sale.totalMinor } });
  created(res, { sale });
});

export const reverse = asyncHandler(async (req: Request, res: Response) => {
  const sale = await service.reverseSale(ctx(req), req.params.id!, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'SALE_REVERSE', resource: 'Sale', resourceId: req.params.id, ip: req.ip });
  ok(res, { sale });
});
