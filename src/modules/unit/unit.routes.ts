import { Router } from 'express';
import { z } from 'zod';
import * as unitService from './unit.service.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { Permission } from '../../constants/permissions.js';
import { UnitKind } from '../../models/unit.model.js';
import type { Request, Response } from 'express';
import type { TenantContext } from '../../types/context.js';

const createUnitSchema = z.object({
  name: z.string().trim().min(1).max(40),
  symbol: z.string().trim().min(1).max(10),
  kind: z.nativeEnum(UnitKind).optional(),
  allowsDecimal: z.boolean().optional(),
});

const ctx = (req: Request): TenantContext => req.tenant!;

export const unitRouter = Router();

unitRouter.use(authenticate, resolveTenant);

unitRouter.get(
  '/',
  authorize(Permission.PRODUCT_VIEW),
  asyncHandler(async (req: Request, res: Response) => {
    const units = await unitService.listUnits(ctx(req));
    ok(res, units);
  }),
);

unitRouter.post(
  '/',
  authorize(Permission.UNIT_MANAGE),
  validate({ body: createUnitSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const unit = await unitService.createUnit(ctx(req), req.body);
    created(res, { unit });
  }),
);
