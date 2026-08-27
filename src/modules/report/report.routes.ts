import { Router } from 'express';
import type { Request, Response } from 'express';
import * as reports from '../../services/report.service.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize, requireRole } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { Permission } from '../../constants/permissions.js';
import { Role } from '../../constants/roles.js';
import type { TenantContext } from '../../types/context.js';

const ctx = (req: Request): TenantContext => {
  if (!req.tenant) throw ApiError.forbidden('Shop context required', 'NO_SHOP');
  return req.tenant;
};

export const reportRouter = Router();

reportRouter.use(authenticate);

// Shop reports (tenant-scoped, REPORT_VIEW)
reportRouter.get('/dashboard', authorize(Permission.REPORT_VIEW), resolveTenant, asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reports.dashboard(ctx(req), req.query.range as string | undefined));
}));

reportRouter.get('/profit-loss', authorize(Permission.REPORT_VIEW), resolveTenant, asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reports.profitLoss(ctx(req)));
}));

reportRouter.get('/daily', authorize(Permission.REPORT_VIEW), resolveTenant, asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reports.daily(ctx(req), req.query.date as string | undefined));
}));

reportRouter.get('/monthly', authorize(Permission.REPORT_VIEW), resolveTenant, asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reports.monthly(ctx(req), req.query.month as string | undefined));
}));

reportRouter.get('/daily-milk', authorize(Permission.REPORT_VIEW), resolveTenant, asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reports.dailyMilk(ctx(req), req.query.date as string | undefined));
}));

// Platform overview (super admin only, no tenant)
reportRouter.get('/platform/overview', requireRole(Role.SUPER_ADMIN), asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await reports.platformOverview());
}));
