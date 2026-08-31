import * as paymentRepo from '../../repositories/dynamo/paymentRepository.js';
import * as customerRepo from '../../repositories/dynamo/customerRepository.js';
import * as settingsRepo from '../../repositories/dynamo/shopSettingsRepository.js';
import { ApiError } from '../../utils/ApiError.js';
import { toMinor, formatPKR } from '../../utils/money.js';
import { parsePagination, paginateInMemory } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { postLedgerEntry } from '../../services/ledger.service.js';
import { LedgerEntryType, LedgerRefType } from '../../constants/sales.js';
import type { TenantContext } from '../../types/context.js';
import type { CreatePaymentInput } from './payment.validators.js';

async function assertMethod(ctx: TenantContext, method?: string): Promise<string> {
  const settings = await settingsRepo.getOrCreate(ctx.shopId);
  const allowed = settings?.paymentMethods ?? [];
  if (!method) return allowed[0] ?? 'CASH';
  if (allowed.length && !allowed.includes(method)) {
    throw ApiError.badRequest(`Invalid payment method: ${method}`, 'INVALID_PAYMENT_METHOD');
  }
  return method;
}

/**
 * Record a customer payment (§66): create the receipt, then post a ledger CREDIT
 * that reduces the outstanding balance. The balance is never written directly —
 * it flows from the ledger (§37).
 *
 * These were one Mongo transaction. If the ledger post fails the receipt is
 * removed, so a payment can never exist without the credit that justifies it.
 */
export async function recordPayment(ctx: TenantContext, input: CreatePaymentInput, userId: string) {
  const customer = await customerRepo.findById(ctx.shopId, input.customerId);
  if (!customer) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  const method = await assertMethod(ctx, input.method);
  const amountMinor = toMinor(input.amount);

  // A collection can never exceed what the customer owes (no negative/advance balance).
  const outstandingMinor = Math.max(0, customer.currentBalanceMinor);
  if (amountMinor > outstandingMinor) {
    throw ApiError.badRequest(
      `Payment of ${formatPKR(amountMinor)} exceeds the outstanding balance of ${formatPKR(outstandingMinor)}.`,
      'PAYMENT_EXCEEDS_BALANCE',
    );
  }

  const payment = await paymentRepo.create({
    shopId: ctx.shopId,
    customerId: input.customerId,
    amountMinor,
    method,
    reference: input.reference ?? '',
    note: input.note ?? '',
    receivedBy: userId,
  });

  try {
    const { balanceAfterMinor } = await postLedgerEntry(ctx, {
      customerId: input.customerId,
      entryType: LedgerEntryType.PAYMENT,
      creditMinor: amountMinor,
      refType: LedgerRefType.PAYMENT,
      refId: payment.id,
      note: input.note ?? 'Payment received',
      createdBy: userId,
    });
    return { payment, balanceAfterMinor };
  } catch (err) {
    await paymentRepo.hardDelete(payment).catch(() => undefined);
    throw err;
  }
}

/** Attaches customer name/phone, which used to come from a Mongoose populate. */
async function attachCustomers<T extends { customerId: string }>(ctx: TenantContext, rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.customerId))];
  const customers = await Promise.all(ids.map((id) => customerRepo.findById(ctx.shopId, id)));
  const byId = new Map(customers.filter((c) => c !== null).map((c) => [c.id, c]));
  return rows.map((r) => {
    const c = byId.get(r.customerId);
    return { ...r, customerId: c ? { _id: c.id, name: c.name, phone: c.phone } : r.customerId };
  });
}

export async function listPayments(
  ctx: TenantContext,
  query: unknown,
  filters: { customerId?: string; from?: string; to?: string },
) {
  const { page, limit, skip, sort } = parsePagination(query, '-receivedAt');
  let rows = filters.customerId
    ? await paymentRepo.listByCustomer(ctx.shopId, filters.customerId)
    : await paymentRepo.listByShop(ctx.shopId);

  if (filters.from || filters.to) {
    const from = filters.from ? new Date(filters.from).getTime() : -Infinity;
    const to = filters.to ? new Date(filters.to).getTime() : Infinity;
    rows = rows.filter((p) => {
      const t = new Date(p.receivedAt).getTime();
      return t >= from && t <= to;
    });
  }

  const { data, total } = paginateInMemory(rows, { skip, limit, sort });
  return { data: await attachCustomers(ctx, data), meta: buildPageMeta(page, limit, total) };
}

/** Reverse a payment (§79): post a compensating ledger DEBIT; mark it reversed. */
export async function reversePayment(ctx: TenantContext, id: string, userId: string) {
  const payment = await paymentRepo.findScoped(ctx.shopId, id);
  if (!payment) throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  if (payment.reversedAt) throw ApiError.conflict('Payment already reversed', 'PAYMENT_ALREADY_REVERSED');

  await postLedgerEntry(ctx, {
    customerId: payment.customerId,
    entryType: LedgerEntryType.REVERSAL,
    debitMinor: payment.amountMinor,
    refType: LedgerRefType.PAYMENT,
    refId: payment.id,
    note: 'Payment reversal',
    createdBy: userId,
  });

  return paymentRepo.markReversed(payment);
}
