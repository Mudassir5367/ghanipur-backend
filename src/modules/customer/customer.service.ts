import * as customerRepo from '../../repositories/dynamo/customerRepository.js';
import * as ledgerRepo from '../../repositories/dynamo/customerLedgerRepository.js';
import * as settingsRepo from '../../repositories/dynamo/shopSettingsRepository.js';
import { ApiError } from '../../utils/ApiError.js';
import { toMinor } from '../../utils/money.js';
import { parsePagination, paginateInMemory } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { postLedgerEntry, getLedgerSummary } from '../../services/ledger.service.js';
import { outstandingByCustomers } from '../delivery/delivery.service.js';
import { LedgerEntryType } from '../../constants/sales.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateCustomerInput, UpdateCustomerInput } from './customer.validators.js';

async function assertType(ctx: TenantContext, type?: string): Promise<void> {
  if (!type) return;
  const settings = await settingsRepo.getOrCreate(ctx.shopId);
  const allowed = settings?.customerTypes ?? [];
  if (allowed.length && !allowed.includes(type)) {
    throw ApiError.badRequest(`Invalid customer type: ${type}`, 'INVALID_CUSTOMER_TYPE');
  }
}

/**
 * Creates the customer, then posts their opening balance as the first ledger
 * entry so the cached balance and the ledger agree from the very first row.
 *
 * These were one Mongo transaction. If the ledger post fails the customer is
 * removed, rather than leaving one whose balance disagrees with an empty ledger.
 */
export async function createCustomer(ctx: TenantContext, input: CreateCustomerInput, userId: string) {
  await assertType(ctx, input.type);
  const openingMinor = input.openingBalance ? toMinor(input.openingBalance) : 0;

  const customer = await customerRepo.create({
    shopId: ctx.shopId,
    name: input.name,
    phone: input.phone,
    altPhone: input.altPhone,
    address: input.address ?? '',
    type: input.type ?? 'INDIVIDUAL',
    notes: input.notes ?? '',
    creditLimitMinor: input.creditLimit ? toMinor(input.creditLimit) : 0,
    // The ledger entry below is what moves the balance; starting at 0 keeps the
    // two in step instead of double-counting the opening figure.
    openingBalanceMinor: 0,
  });

  if (openingMinor !== 0) {
    try {
      await postLedgerEntry(ctx, {
        customerId: customer.id,
        entryType: LedgerEntryType.OPENING,
        debitMinor: openingMinor > 0 ? openingMinor : 0,
        creditMinor: openingMinor < 0 ? -openingMinor : 0,
        note: 'Opening balance',
        createdBy: userId,
      });
    } catch (err) {
      await customerRepo.hardDelete(ctx.shopId, customer.id).catch(() => undefined);
      throw err;
    }
    await customerRepo.update(ctx.shopId, customer.id, { openingBalanceMinor: openingMinor });
    customer.openingBalanceMinor = openingMinor;
    customer.currentBalanceMinor = openingMinor;
  }
  return customer;
}

export async function listCustomers(
  ctx: TenantContext,
  query: unknown,
  filters: { status?: string; type?: string; hasDue?: string; from?: string; to?: string },
) {
  const { page, limit, skip, sort, search } = parsePagination(query, 'name');
  let rows = await customerRepo.listByShop(ctx.shopId);
  if (filters.status) rows = rows.filter((c) => c.status === filters.status);
  if (filters.type) rows = rows.filter((c) => c.type === filters.type);
  if (filters.hasDue === 'true') rows = rows.filter((c) => c.currentBalanceMinor > 0);

  // Date-wise: customers whose last sale, last payment, or creation date is in range.
  if (filters.from || filters.to) {
    const from = filters.from ? new Date(filters.from).getTime() : -Infinity;
    const to = filters.to ? new Date(filters.to).getTime() : Infinity;
    const inRange = (v: string | null) => v !== null && new Date(v).getTime() >= from && new Date(v).getTime() <= to;
    rows = rows.filter((c) => inRange(c.lastSaleAt) || inRange(c.lastPaymentAt) || inRange(c.createdAt));
  }

  const { data, total } = paginateInMemory(rows, { skip, limit, sort }, { search, fields: (c) => [c.name, c.phone] });

  // Unify outstanding: ledger balance + delivery dues (§10). Derived, never stored.
  const deliveryDues = await outstandingByCustomers(ctx, data.map((c) => c.id));
  const withDues = data.map((c) => {
    const deliveryOutstandingMinor = deliveryDues.get(c.id) ?? 0;
    // Clamp ledger to >=0 so a sales-ledger advance never masks delivery dues.
    const totalOutstandingMinor = Math.max(0, c.currentBalanceMinor) + deliveryOutstandingMinor;
    return { ...c, deliveryOutstandingMinor, totalOutstandingMinor };
  });
  return { data: withDues, meta: buildPageMeta(page, limit, total) };
}

export async function getCustomer(ctx: TenantContext, id: string) {
  const customer = await customerRepo.findById(ctx.shopId, id);
  if (!customer) throw ApiError.notFound('Customer not found', 'CUSTOMER_NOT_FOUND');
  return customer;
}

export async function updateCustomer(ctx: TenantContext, id: string, input: UpdateCustomerInput) {
  await getCustomer(ctx, id);
  if (input.type) await assertType(ctx, input.type);
  const { creditLimit, ...rest } = input as UpdateCustomerInput & { creditLimit?: number };
  const patch = { ...rest } as customerRepo.CustomerPatch;
  if (creditLimit !== undefined) patch.creditLimitMinor = toMinor(creditLimit);
  return customerRepo.update(ctx.shopId, id, patch);
}

export async function deleteCustomer(ctx: TenantContext, id: string, userId: string) {
  const customer = await getCustomer(ctx, id);
  if (customer.currentBalanceMinor !== 0) {
    throw ApiError.conflict('Customer has an outstanding balance and cannot be deleted', 'CUSTOMER_HAS_BALANCE');
  }
  await customerRepo.update(ctx.shopId, id, { status: customerRepo.CustomerStatus.INACTIVE });
  return customerRepo.softDelete(ctx.shopId, id, userId);
}

export async function getCustomerLedger(
  ctx: TenantContext,
  id: string,
  query: unknown,
  range: { from?: string; to?: string } = {},
) {
  const customer = await getCustomer(ctx, id);
  const { page, limit, skip, sort } = parsePagination(query, '-occurredAt');

  let rows = (await ledgerRepo.listByCustomer(id)).filter((e) => e.shopId === ctx.shopId);
  if (range.from || range.to) {
    const from = range.from ? new Date(range.from).getTime() : -Infinity;
    const to = range.to ? new Date(range.to).getTime() : Infinity;
    rows = rows.filter((e) => {
      const t = new Date(e.occurredAt).getTime();
      return t >= from && t <= to;
    });
  }

  // Totals for the selected range (charged vs paid) — powers the weekly/monthly view.
  const period = {
    debitMinor: rows.reduce((s, e) => s + e.debitMinor, 0),
    creditMinor: rows.reduce((s, e) => s + e.creditMinor, 0),
    count: rows.length,
  };

  const { data, total } = paginateInMemory(rows, { skip, limit, sort });
  const summary = await getLedgerSummary(ctx, id);
  return { customer, entries: data, summary, period, meta: buildPageMeta(page, limit, total) };
}
