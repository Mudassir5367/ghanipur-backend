import { Types } from 'mongoose';
import { Customer } from '../../models/customer.model.js';
import { CustomerLedger } from '../../models/customerLedger.model.js';
import { ShopSettings } from '../../models/shopSettings.model.js';
import { tenantRepository } from '../../repositories/tenantRepository.js';
import { ApiError } from '../../utils/ApiError.js';
import { toMinor } from '../../utils/money.js';
import { parsePagination } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { withTransaction } from '../../utils/withTransaction.js';
import { postLedgerEntry, getLedgerSummary } from '../../services/ledger.service.js';
import { outstandingByCustomers } from '../delivery/delivery.service.js';
import { LedgerEntryType } from '../../constants/sales.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateCustomerInput, UpdateCustomerInput } from './customer.validators.js';

const repo = tenantRepository(Customer);

async function assertType(ctx: TenantContext, type?: string): Promise<void> {
  if (!type) return;
  const settings = await ShopSettings.findOne({ shopId: ctx.shopId });
  const allowed = settings?.customerTypes ?? [];
  if (allowed.length && !allowed.includes(type)) {
    throw ApiError.badRequest(`Invalid customer type: ${type}`, 'INVALID_CUSTOMER_TYPE');
  }
}

export async function createCustomer(ctx: TenantContext, input: CreateCustomerInput, userId: string) {
  await assertType(ctx, input.type);
  const openingMinor = input.openingBalance ? toMinor(input.openingBalance) : 0;

  return withTransaction(async (session) => {
    const [customer] = await Customer.create(
      [{
        shopId: ctx.shopId,
        name: input.name,
        phone: input.phone,
        altPhone: input.altPhone,
        address: input.address ?? '',
        type: input.type ?? 'INDIVIDUAL',
        notes: input.notes ?? '',
        creditLimitMinor: input.creditLimit ? toMinor(input.creditLimit) : 0,
        openingBalanceMinor: openingMinor,
      }],
      { session },
    );

    if (openingMinor !== 0) {
      await postLedgerEntry(
        ctx,
        {
          customerId: customer!._id.toString(),
          entryType: LedgerEntryType.OPENING,
          debitMinor: openingMinor > 0 ? openingMinor : 0,
          creditMinor: openingMinor < 0 ? -openingMinor : 0,
          note: 'Opening balance',
          createdBy: userId,
        },
        session,
      );
      customer!.currentBalanceMinor = openingMinor;
    }
    return customer!;
  });
}

export async function listCustomers(ctx: TenantContext, query: unknown, filters: { status?: string; type?: string; hasDue?: string; from?: string; to?: string }) {
  const { page, limit, skip, sort, search } = parsePagination(query, 'name');
  const filter: Record<string, unknown> = repo.scoped(ctx, { isDeleted: false });
  if (filters.status) filter.status = filters.status;
  if (filters.type) filter.type = filters.type;
  if (filters.hasDue === 'true') filter.currentBalanceMinor = { $gt: 0 };

  const and: Record<string, unknown>[] = [];
  if (search) and.push({ $or: [{ name: { $regex: search, $options: 'i' } }, { phone: { $regex: search, $options: 'i' } }] });
  // Date-wise: customers whose last sale, last payment, or creation date is in range.
  if (filters.from || filters.to) {
    const range: Record<string, Date> = {};
    if (filters.from) range.$gte = new Date(filters.from);
    if (filters.to) range.$lte = new Date(filters.to);
    and.push({ $or: [{ lastSaleAt: range }, { lastPaymentAt: range }, { createdAt: range }] });
  }
  if (and.length) filter.$and = and;

  const [docs, total] = await Promise.all([
    Customer.find(filter).sort(sort).skip(skip).limit(limit),
    Customer.countDocuments(filter),
  ]);
  // Unify outstanding: ledger balance + delivery dues (§10). Derived, never stored.
  const deliveryDues = await outstandingByCustomers(ctx, docs.map((c) => c._id.toString()));
  const data = docs.map((c) => {
    const deliveryOutstandingMinor = deliveryDues.get(c._id.toString()) ?? 0;
    // Clamp ledger to >=0 so a sales-ledger advance never masks delivery dues.
    const totalOutstandingMinor = Math.max(0, c.currentBalanceMinor) + deliveryOutstandingMinor;
    return { ...c.toObject(), deliveryOutstandingMinor, totalOutstandingMinor };
  });
  return { data, meta: buildPageMeta(page, limit, total) };
}

export async function getCustomer(ctx: TenantContext, id: string) {
  const customer = await repo.findOne(ctx, { _id: id, isDeleted: false });
  if (!customer) throw ApiError.notFound('Customer not found', 'CUSTOMER_NOT_FOUND');
  return customer;
}

export async function updateCustomer(ctx: TenantContext, id: string, input: UpdateCustomerInput) {
  await getCustomer(ctx, id);
  if (input.type) await assertType(ctx, input.type);
  const update: Record<string, unknown> = { ...input };
  if (input.creditLimit !== undefined) update.creditLimitMinor = toMinor(input.creditLimit);
  delete (update as { creditLimit?: unknown }).creditLimit;
  return repo.updateById(ctx, id, update);
}

export async function deleteCustomer(ctx: TenantContext, id: string, userId: string) {
  const customer = await getCustomer(ctx, id);
  if (customer.currentBalanceMinor !== 0) {
    throw ApiError.conflict('Customer has an outstanding balance and cannot be deleted', 'CUSTOMER_HAS_BALANCE');
  }
  return repo.updateById(ctx, id, { isDeleted: true, deletedAt: new Date(), deletedBy: userId, status: 'INACTIVE' });
}

export async function getCustomerLedger(ctx: TenantContext, id: string, query: unknown, range: { from?: string; to?: string } = {}) {
  const customer = await getCustomer(ctx, id);
  const { page, limit, skip } = parsePagination(query, '-occurredAt');
  const filter: Record<string, unknown> = { shopId: ctx.shopId, customerId: id };
  if (range.from || range.to) {
    const occurred: Record<string, Date> = {};
    if (range.from) occurred.$gte = new Date(range.from);
    if (range.to) occurred.$lte = new Date(range.to);
    filter.occurredAt = occurred;
  }
  const match: Record<string, unknown> = { shopId: new Types.ObjectId(ctx.shopId), customerId: new Types.ObjectId(id) };
  if (filter.occurredAt) match.occurredAt = filter.occurredAt;
  const [entries, total, summary, periodAgg] = await Promise.all([
    CustomerLedger.find(filter).sort({ occurredAt: -1, createdAt: -1 }).skip(skip).limit(limit),
    CustomerLedger.countDocuments(filter),
    getLedgerSummary(ctx, id),
    // Totals for the selected range (charged vs paid) — powers the weekly/monthly view.
    CustomerLedger.aggregate<{ debit: number; credit: number; count: number }>([
      { $match: match },
      { $group: { _id: null, debit: { $sum: '$debitMinor' }, credit: { $sum: '$creditMinor' }, count: { $sum: 1 } } },
    ]),
  ]);
  const period = { debitMinor: periodAgg[0]?.debit ?? 0, creditMinor: periodAgg[0]?.credit ?? 0, count: periodAgg[0]?.count ?? 0 };
  return { customer, entries, summary, period, meta: buildPageMeta(page, limit, total) };
}
