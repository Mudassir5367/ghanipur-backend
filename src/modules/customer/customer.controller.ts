import type { Request, Response } from 'express';
import * as service from './customer.service.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { TenantContext } from '../../types/context.js';

function ctx(req: Request): TenantContext {
  if (!req.tenant) throw ApiError.forbidden('Shop context required', 'NO_SHOP');
  return req.tenant;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await service.listCustomers(ctx(req), req.query, {
    status: req.query.status as string | undefined,
    type: req.query.type as string | undefined,
    hasDue: req.query.hasDue as string | undefined,
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
  });
  ok(res, data, 200, meta);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const customer = await service.getCustomer(ctx(req), req.params.id!);
  ok(res, { customer });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const customer = await service.createCustomer(ctx(req), req.body, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'CUSTOMER_CREATE', resource: 'Customer', resourceId: customer._id.toString(), ip: req.ip });
  created(res, { customer });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const customer = await service.updateCustomer(ctx(req), req.params.id!, req.body);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'CUSTOMER_UPDATE', resource: 'Customer', resourceId: req.params.id, ip: req.ip });
  ok(res, { customer });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await service.deleteCustomer(ctx(req), req.params.id!, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'CUSTOMER_DELETE', resource: 'Customer', resourceId: req.params.id, ip: req.ip });
  ok(res, { message: 'Customer deleted' });
});

export const ledger = asyncHandler(async (req: Request, res: Response) => {
  const { customer, entries, summary, period, meta } = await service.getCustomerLedger(ctx(req), req.params.id!, req.query, {
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
  });
  ok(res, { customer, entries, summary, period }, 200, meta);
});
