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
import { ApiError } from '../../utils/ApiError.js';
import { idParamSchema } from '../../utils/validators.js';
import type { TenantContext } from '../../types/context.js';

const createExpenseSchema = z.object({
  category: z.string().trim().min(1).max(40),
  amount: z.number().positive(),
  method: z.string().trim().max(30).optional(),
  description: z.string().max(300).optional(),
  isRecurring: z.boolean().optional(),
  incurredAt: z.string().datetime().optional(),
});

// Every field is editable, including the date; at least one must be sent.
const updateExpenseSchema = createExpenseSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'Nothing to update',
});

const ctx = (req: Request): TenantContext => req.tenant!;

/** Optional ISO date bound; a malformed value is a client error rather than "no filter". */
function bound(value: unknown, field: string): number | null {
  if (value === undefined || value === '') return null;
  const t = new Date(String(value)).getTime();
  if (Number.isNaN(t)) throw ApiError.badRequest(`Invalid ${field} date`, 'INVALID_DATE');
  return t;
}

export const expenseRouter = Router();
expenseRouter.use(authenticate, resolveTenant);

expenseRouter.get('/', authorize(Permission.EXPENSE_VIEW), asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip, sort } = parsePagination(req.query, '-incurredAt');
  let rows = await expenses.listByShop(ctx(req).shopId);
  if (req.query.category) rows = rows.filter((e) => e.category === req.query.category);
  // ?from&to — the daily expenditure breakdown.
  const from = bound(req.query.from, 'from');
  const to = bound(req.query.to, 'to');
  if (from !== null || to !== null) {
    rows = rows.filter((e) => {
      const t = new Date(e.incurredAt).getTime();
      return (from === null || t >= from) && (to === null || t <= to);
    });
  }
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

// Editing and deleting need the same authority as recording (shop admins).
expenseRouter.patch('/:id', authorize(Permission.EXPENSE_CREATE), validate({ params: idParamSchema, body: updateExpenseSchema }), asyncHandler(async (req: Request, res: Response) => {
  const existing = await expenses.findScoped(ctx(req).shopId, req.params.id!);
  if (!existing) throw ApiError.notFound('Expense not found', 'EXPENSE_NOT_FOUND');
  const b = req.body as z.infer<typeof updateExpenseSchema>;
  const expense = await expenses.update(existing, {
    ...(b.category !== undefined ? { category: b.category } : {}),
    ...(b.amount !== undefined ? { amountMinor: toMinor(b.amount) } : {}),
    ...(b.method !== undefined ? { method: b.method } : {}),
    ...(b.description !== undefined ? { description: b.description } : {}),
    ...(b.isRecurring !== undefined ? { isRecurring: b.isRecurring } : {}),
    ...(b.incurredAt !== undefined ? { incurredAt: new Date(b.incurredAt).toISOString() } : {}),
  });
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'EXPENSE_UPDATE', resource: 'Expense', resourceId: expense.id, ip: req.ip });
  ok(res, { expense });
}));

expenseRouter.delete('/:id', authorize(Permission.EXPENSE_CREATE), validate({ params: idParamSchema }), asyncHandler(async (req: Request, res: Response) => {
  const existing = await expenses.findScoped(ctx(req).shopId, req.params.id!);
  if (!existing) throw ApiError.notFound('Expense not found', 'EXPENSE_NOT_FOUND');
  await expenses.remove(existing);
  await recordAudit({ actorId: req.auth!.userId, actorRole: req.auth!.role, shopId: ctx(req).shopId, action: 'EXPENSE_DELETE', resource: 'Expense', resourceId: existing.id, ip: req.ip });
  ok(res, { message: 'Expense deleted' });
}));
