import type { Request, Response } from 'express';
import * as staffService from './staff.service.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../../services/audit.service.js';

function shopId(req: Request): string {
  if (!req.tenant) throw ApiError.forbidden('Shop context required', 'NO_SHOP');
  return req.tenant.shopId;
}

export const listStaff = asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await staffService.listStaff(shopId(req), req.query);
  ok(res, data, 200, meta);
});

export const createStaff = asyncHandler(async (req: Request, res: Response) => {
  const sid = shopId(req);
  const staff = await staffService.createStaff(sid, req.body);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: sid, action: 'STAFF_CREATE', resource: 'User', resourceId: staff.id, ip: req.ip });
  created(res, { staff });
});

export const updateStaff = asyncHandler(async (req: Request, res: Response) => {
  const sid = shopId(req);
  const staff = await staffService.updateStaff(sid, req.params.id!, req.body);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: sid, action: 'STAFF_UPDATE', resource: 'User', resourceId: staff.id, ip: req.ip });
  ok(res, { staff });
});

export const deactivateStaff = asyncHandler(async (req: Request, res: Response) => {
  const sid = shopId(req);
  const staff = await staffService.deactivateStaff(sid, req.params.id!);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: sid, action: 'STAFF_DEACTIVATE', resource: 'User', resourceId: staff.id, ip: req.ip });
  ok(res, { staff });
});
