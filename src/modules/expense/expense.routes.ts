import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { expenses } from '../../repositories/dynamo/miscRepositories.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, ok, created, buildPageMeta } from '../../utils/http.js';
import { Permission } from '../../constants/permissions.js';
import { toMinor } from '../../utils/money.js';
import { parsePagination, paginateInMemory } from '../../utils/pagination.js';
import { recordAudit } from '../../services/audit.service.js';
import type { TenantContext } from '../../types/context.js';

const createExpenseSchema = z.object({
  category: z.string().trim().min(1).max(40),
  amount: z.number().positive(),
  method: z.string().trim().max(30).optional(),
  description: z.string().max(300).optional(),
  isRecurring: z.boolean().optional(),
  incurredAt: z.string().datetime().optional(),
});

const ctx = (req: Request): TenantContext => req.tenant!;

export const expenseRouter = Router();
expenseRouter.use(authenticate, resolveTenant);

expenseRouter.get('/', authorize(Permission.EXPENSE_VIEW), asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip, sort } = parsePagination(req.query, '-incurredAt');
  let rows = await expenses.listByShop(ctx(req).shopId);
  if (req.query.category) rows = rows.filter((e) => e.category === req.query.category);
  const { data, total } = paginateInMemory(rows, { skip, limit, sort });
  ok(res, data, 200, buildPageMeta(page, limit, total));
}));

expenseRouter.post('/', authorize(Permission.EXPENSE_CREATE), validate({ body: createExpenseSchema }), asyncHandler(async (req: Request, res: Response) => {
  const b = req.body as z.infer<typeof createExpenseSchema>;
  const expense = await expenses.create({
    shopId: ctx(req).shopId,
    category: b.category,
    amountMinor: toMinor(b.amount),
    method: b.method ?? 'CASH',
    description: b.description ?? '',
    isRecurring: b.isRecurring ?? false,
    incurredAt: b.incurredAt ? new Date(b.incurredAt) : undefined,
    createdBy: req.auth!.userId,
  });
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'EXPENSE_CREATE', resource: 'Expense', resourceId: expense.id, ip: req.ip });
  created(res, { expense });
}));
