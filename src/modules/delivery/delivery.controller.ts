import type { Request, Response } from 'express';
import * as service from './delivery.service.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { DeliveryStatus } from '../../models/delivery.model.js';
import type { TenantContext } from '../../types/context.js';

function ctx(req: Request): TenantContext {
  if (!req.tenant) throw ApiError.forbidden('Shop context required', 'NO_SHOP');
  return req.tenant;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await service.listDeliveries(ctx(req), req.query, {
    status: req.query.status as string | undefined,
    paymentStatus: req.query.paymentStatus as string | undefined,
    customerId: req.query.customerId as string | undefined,
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
  });
  ok(res, data, 200, meta);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const delivery = await service.getDelivery(ctx(req), req.params.id!);
  ok(res, { delivery });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const delivery = await service.createDelivery(ctx(req), req.body, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'DELIVERY_CREATE', resource: 'Delivery', resourceId: delivery._id.toString(), ip: req.ip });
  created(res, { delivery });
});

export const roster = asyncHandler(async (req: Request, res: Response) => {
  const data = await service.deliveryRoster(ctx(req));
  ok(res, data);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const delivery = await service.updateDelivery(ctx(req), req.params.id!, req.body, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'DELIVERY_UPDATE', resource: 'Delivery', resourceId: req.params.id, ip: req.ip });
  ok(res, { delivery });
});

export const setStatus = asyncHandler(async (req: Request, res: Response) => {
  const status = req.body.status as DeliveryStatus;
  const delivery = await service.changeStatus(ctx(req), req.params.id!, status, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: `DELIVERY_${status}`, resource: 'Delivery', resourceId: req.params.id, ip: req.ip });
  ok(res, { delivery });
});

export const addPayment = asyncHandler(async (req: Request, res: Response) => {
  const delivery = await service.addPayment(ctx(req), req.params.id!, req.body, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'DELIVERY_PAYMENT', resource: 'Delivery', resourceId: req.params.id, ip: req.ip, metadata: { amount: req.body.amount } });
  ok(res, { delivery });
});

export const customerSummary = asyncHandler(async (req: Request, res: Response) => {
  const summary = await service.customerDeliverySummary(ctx(req), req.params.customerId!);
  ok(res, summary);
});
