import type { Request, Response } from 'express';
import * as service from './payment.service.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { TenantContext } from '../../types/context.js';

function ctx(req: Request): TenantContext {
  if (!req.tenant) throw ApiError.forbidden('Shop context required', 'NO_SHOP');
  return req.tenant;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await service.listPayments(ctx(req), req.query, {
    customerId: req.query.customerId as string | undefined,
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
  });
  ok(res, data, 200, meta);
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const { payment, balanceAfterMinor } = await service.recordPayment(ctx(req), req.body, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'PAYMENT_CREATE', resource: 'Payment', resourceId: payment._id.toString(), ip: req.ip, metadata: { amountMinor: payment.amountMinor } });
  created(res, { payment, balanceAfterMinor });
});

export const reverse = asyncHandler(async (req: Request, res: Response) => {
  const payment = await service.reversePayment(ctx(req), req.params.id!, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'PAYMENT_REVERSE', resource: 'Payment', resourceId: req.params.id, ip: req.ip });
  ok(res, { payment });
});
