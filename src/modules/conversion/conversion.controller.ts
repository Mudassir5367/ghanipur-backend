import type { Request, Response } from 'express';
import * as service from './conversion.service.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { TenantContext } from '../../types/context.js';

function ctx(req: Request): TenantContext {
  if (!req.tenant) throw ApiError.forbidden('Shop context required', 'NO_SHOP');
  return req.tenant;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { data, meta } = await service.listConversions(ctx(req), req.query as Record<string, unknown>);
  ok(res, data, 200, meta);
});

export const options = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await service.conversionOptions(ctx(req)));
});

export const summary = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await service.conversionSummary(ctx(req), req.query as Record<string, unknown>));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const conversion = await service.createConversion(ctx(req), req.body, req.auth!.userId);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'CONVERSION_CREATE', resource: 'Conversion', resourceId: conversion.id, ip: req.ip });
  created(res, { conversion });
});
