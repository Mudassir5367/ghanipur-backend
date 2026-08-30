import { Payment } from '../../models/payment.model.js';
import { Customer } from '../../models/customer.model.js';
import { ShopSettings } from '../../models/shopSettings.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { toMinor, formatPKR } from '../../utils/money.js';
import { parsePagination } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { withTransaction } from '../../utils/withTransaction.js';
import { postLedgerEntry } from '../../services/ledger.service.js';
import { LedgerEntryType, LedgerRefType } from '../../constants/sales.js';
import type { TenantContext } from '../../types/context.js';
import type { CreatePaymentInput } from './payment.validators.js';

async function assertMethod(ctx: TenantContext, method?: string): Promise<string> {
  const settings = await ShopSettings.findOne({ shopId: ctx.shopId });
  const allowed = settings?.paymentMethods ?? [];
  if (!method) return allowed[0] ?? 'CASH';
  if (allowed.length && !allowed.includes(method)) throw ApiError.badRequest(`Invalid payment method: ${method}`, 'INVALID_PAYMENT_METHOD');
  return method;
}

/**
 * Record a customer payment (§66). Atomically: create the Payment receipt and post
 * a ledger CREDIT that reduces the customer's outstanding balance. Balance is never
 * written directly — it flows from the ledger (§37).
 */
export async function recordPayment(ctx: TenantContext, input: CreatePaymentInput, userId: string) {
  const customer = await Customer.findOne({ _id: input.customerId, shopId: ctx.shopId, isDeleted: false });
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

  return withTransaction(async (session) => {
    const [payment] = await Payment.create(
      [{ shopId: ctx.shopId, customerId: input.customerId, amountMinor, method, reference: input.reference ?? '', note: input.note ?? '', receivedBy: userId }],
      { session },
    );

    const { balanceAfterMinor } = await postLedgerEntry(
      ctx,
      { customerId: input.customerId, entryType: LedgerEntryType.PAYMENT, creditMinor: amountMinor, refType: LedgerRefType.PAYMENT, refId: payment!._id, note: input.note ?? 'Payment received', createdBy: userId },
      session,
    );

    return { payment: payment!, balanceAfterMinor };
  });
}

export async function listPayments(ctx: TenantContext, query: unknown, filters: { customerId?: string; from?: string; to?: string }) {
  const { page, limit, skip, sort } = parsePagination(query, '-receivedAt');
  const filter: Record<string, unknown> = { shopId: ctx.shopId };
  if (filters.customerId) filter.customerId = filters.customerId;
  if (filters.from || filters.to) {
    filter.receivedAt = {} as Record<string, Date>;
    if (filters.from) (filter.receivedAt as Record<string, Date>).$gte = new Date(filters.from);
    if (filters.to) (filter.receivedAt as Record<string, Date>).$lte = new Date(filters.to);
  }
  const [data, total] = await Promise.all([
    Payment.find(filter).sort(sort).skip(skip).limit(limit).populate('customerId', 'name phone'),
    Payment.countDocuments(filter),
  ]);
  return { data, meta: buildPageMeta(page, limit, total) };
}

/** Reverse a payment (§79): post a compensating ledger DEBIT; mark it reversed. */
export async function reversePayment(ctx: TenantContext, id: string, userId: string) {
  const payment = await Payment.findOne({ _id: id, shopId: ctx.shopId });
  if (!payment) throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  if (payment.reversedAt) throw ApiError.conflict('Payment already reversed', 'PAYMENT_ALREADY_REVERSED');

  return withTransaction(async (session) => {
    await postLedgerEntry(
      ctx,
      { customerId: payment.customerId.toString(), entryType: LedgerEntryType.REVERSAL, debitMinor: payment.amountMinor, refType: LedgerRefType.PAYMENT, refId: payment._id, note: 'Payment reversal', createdBy: userId },
      session,
    );
    payment.reversedAt = new Date();
    await payment.save({ session });
    return payment;
  });
}
