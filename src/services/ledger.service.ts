import { Types as MongooseTypes, type ClientSession, type Types } from 'mongoose';
import { Customer } from '../models/customer.model.js';
import { CustomerLedger } from '../models/customerLedger.model.js';
import { LedgerEntryType, LedgerRefType } from '../constants/sales.js';
import { ApiError } from '../utils/ApiError.js';
import type { TenantContext } from '../types/context.js';

export interface LedgerEntryInput {
  customerId: string;
  entryType: LedgerEntryType;
  debitMinor?: number;
  creditMinor?: number;
  refType?: LedgerRefType;
  refId?: Types.ObjectId | string | null;
  note?: string;
  createdBy?: string | null;
  occurredAt?: Date;
}

export interface LedgerPostResult {
  balanceAfterMinor: number;
  entryId: string;
}

/**
 * The ONLY way a customer balance changes (§78). Atomically applies the debit/credit
 * to the cached balance and appends an immutable ledger row whose balanceAfter is the
 * post-update balance — so concurrent credit sales / payments can never drift.
 */
export async function postLedgerEntry(
  ctx: TenantContext,
  input: LedgerEntryInput,
  session?: ClientSession,
): Promise<LedgerPostResult> {
  const debit = input.debitMinor ?? 0;
  const credit = input.creditMinor ?? 0;
  const delta = debit - credit;

  const touch: Record<string, Date> = {};
  if (input.entryType === LedgerEntryType.CREDIT_SALE) touch.lastSaleAt = input.occurredAt ?? new Date();
  if (input.entryType === LedgerEntryType.PAYMENT) touch.lastPaymentAt = input.occurredAt ?? new Date();

  const customer = await Customer.findOneAndUpdate(
    { _id: input.customerId, shopId: ctx.shopId, isDeleted: false },
    { $inc: { currentBalanceMinor: delta }, $set: touch },
    { new: true, session, projection: 'currentBalanceMinor' },
  );
  if (!customer) throw ApiError.notFound('Customer not found', 'CUSTOMER_NOT_FOUND');

  const [entry] = await CustomerLedger.create(
    [{
      shopId: ctx.shopId,
      customerId: input.customerId,
      entryType: input.entryType,
      debitMinor: debit,
      creditMinor: credit,
      balanceAfterMinor: customer.currentBalanceMinor,
      refType: input.refType ?? LedgerRefType.MANUAL,
      refId: input.refId ?? null,
      note: input.note ?? '',
      createdBy: input.createdBy ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    }],
    { session },
  );

  return { balanceAfterMinor: customer.currentBalanceMinor, entryId: entry!._id.toString() };
}

/** Totals for a customer's ledger (§13): sum of debits, credits, and outstanding. */
export async function getLedgerSummary(ctx: TenantContext, customerId: string) {
  const agg = await CustomerLedger.aggregate<{ _id: null; debit: number; credit: number }>([
    { $match: { shopId: toObjectId(ctx.shopId), customerId: toObjectId(customerId) } },
    { $group: { _id: null, debit: { $sum: '$debitMinor' }, credit: { $sum: '$creditMinor' } } },
  ]);
  const debit = agg[0]?.debit ?? 0;
  const credit = agg[0]?.credit ?? 0;
  return { totalDebitMinor: debit, totalCreditMinor: credit, outstandingMinor: debit - credit };
}

/** Recompute cached balance from the ledger (repair/audit — §37). */
export async function recomputeCustomerBalance(ctx: TenantContext, customerId: string): Promise<number> {
  const { outstandingMinor } = await getLedgerSummary(ctx, customerId);
  await Customer.updateOne({ _id: customerId, shopId: ctx.shopId }, { currentBalanceMinor: outstandingMinor });
  return outstandingMinor;
}

function toObjectId(id: string): Types.ObjectId {
  return new MongooseTypes.ObjectId(id);
}
