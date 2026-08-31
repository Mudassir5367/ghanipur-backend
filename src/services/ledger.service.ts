import * as customerRepo from '../repositories/dynamo/customerRepository.js';
import * as ledgerRepo from '../repositories/dynamo/customerLedgerRepository.js';
import { LedgerEntryType, LedgerRefType } from '../constants/sales.js';
import { ApiError } from '../utils/ApiError.js';
import type { TenantContext } from '../types/context.js';

export interface LedgerEntryInput {
  customerId: string;
  entryType: LedgerEntryType;
  debitMinor?: number;
  creditMinor?: number;
  refType?: LedgerRefType;
  refId?: string | null;
  note?: string;
  createdBy?: string | null;
  occurredAt?: Date;
}

export interface LedgerPostResult {
  balanceAfterMinor: number;
  entryId: string;
}

/**
 * The ONLY way a customer balance changes (§78).
 *
 * The balance moves in a single atomic update that returns the post-change
 * value, and that exact value is what the immutable ledger row records — so two
 * concurrent credit sales or payments cannot interleave into a wrong
 * balanceAfter. Mongo achieved this with findOneAndUpdate($inc, {new:true});
 * DynamoDB's conditional UpdateItem gives the same single-round-trip guarantee.
 *
 * Deliberately no floor: a customer who overpays goes into credit (negative
 * balance), which the Mongo version also allowed.
 *
 * The unused session parameter remains so callers still inside the old
 * withTransaction wrapper compile; it is ignored and goes away with Mongo.
 */
export async function postLedgerEntry(
  ctx: TenantContext,
  input: LedgerEntryInput,
  _session?: unknown,
): Promise<LedgerPostResult> {
  const debit = input.debitMinor ?? 0;
  const credit = input.creditMinor ?? 0;
  const delta = debit - credit;

  const customer = await customerRepo.findById(ctx.shopId, input.customerId);
  if (!customer) throw ApiError.notFound('Customer not found', 'CUSTOMER_NOT_FOUND');

  const balanceAfterMinor = await customerRepo.adjustBalance(ctx.shopId, input.customerId, delta);
  if (balanceAfterMinor === null) throw ApiError.notFound('Customer not found', 'CUSTOMER_NOT_FOUND');

  const at = input.occurredAt ?? new Date();
  if (input.entryType === LedgerEntryType.CREDIT_SALE) await customerRepo.touchLastSale(ctx.shopId, input.customerId, at);
  if (input.entryType === LedgerEntryType.PAYMENT) await customerRepo.touchLastPayment(ctx.shopId, input.customerId, at);

  const entry = await ledgerRepo.append({
    shopId: ctx.shopId,
    customerId: input.customerId,
    entryType: input.entryType,
    debitMinor: debit,
    creditMinor: credit,
    balanceAfterMinor,
    refType: input.refType ?? LedgerRefType.MANUAL,
    refId: input.refId ? String(input.refId) : null,
    note: input.note ?? '',
    createdBy: input.createdBy ?? null,
    occurredAt: at,
  });

  return { balanceAfterMinor, entryId: entry.id };
}

/** Totals for a customer's ledger (§13): sum of debits, credits, and outstanding. */
export async function getLedgerSummary(ctx: TenantContext, customerId: string) {
  const rows = (await ledgerRepo.listByCustomer(customerId)).filter((r) => r.shopId === ctx.shopId);
  const debit = rows.reduce((s, r) => s + r.debitMinor, 0);
  const credit = rows.reduce((s, r) => s + r.creditMinor, 0);
  return { totalDebitMinor: debit, totalCreditMinor: credit, outstandingMinor: debit - credit };
}

/** Recompute cached balance from the ledger (repair/audit — §37). */
export async function recomputeCustomerBalance(ctx: TenantContext, customerId: string): Promise<number> {
  const { outstandingMinor } = await getLedgerSummary(ctx, customerId);
  const customer = await customerRepo.findById(ctx.shopId, customerId);
  if (customer) {
    // Move by the difference: the ledger is the truth, the cache is being repaired.
    await customerRepo.adjustBalance(ctx.shopId, customerId, outstandingMinor - customer.currentBalanceMinor);
  }
  return outstandingMinor;
}
