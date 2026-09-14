import * as saleRepo from '../../repositories/dynamo/saleRepository.js';
import * as productRepo from '../../repositories/dynamo/productRepository.js';
import * as customerRepo from '../../repositories/dynamo/customerRepository.js';
import { ApiError } from '../../utils/ApiError.js';
import { toMinor } from '../../utils/money.js';
import { generateCode } from '../../utils/code.js';
import { parsePagination, paginateInMemory } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { recordMovement, undoMovements, type MovementResult } from '../../services/inventory.service.js';
import { postLedgerEntry } from '../../services/ledger.service.js';
import { InventoryTxnType, RefType } from '../../constants/inventory.js';
import { SaleType, SaleStatus, LedgerEntryType, LedgerRefType } from '../../constants/sales.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateSaleInput } from './sale.validators.js';

interface PreparedItem {
  productId: string;
  name: string;
  unitId: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  /** Average cost per unit at the moment of sale (see productRepo.averageCostMinor). */
  unitCostMinor: number | undefined;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Loads the products and snapshots name/unit/price for each requested line.
 * `keepUnavailable` lets a correction keep a line whose product has since been
 * marked unavailable — it was legitimately sold at the time.
 */
async function prepareItems(
  ctx: TenantContext,
  items: CreateSaleInput['items'],
  keepUnavailable: ReadonlySet<string> = new Set(),
): Promise<PreparedItem[]> {
  const products = await Promise.all(items.map((i) => productRepo.findById(ctx.shopId, i.productId)));
  const byId = new Map(products.filter((p) => p !== null).map((p) => [p.id, p]));

  return items.map((item) => {
    const product = byId.get(item.productId);
    if (!product) throw ApiError.badRequest(`Product not found: ${item.productId}`, 'PRODUCT_NOT_FOUND');
    if (!product.isAvailable && !keepUnavailable.has(product.id)) {
      throw ApiError.badRequest(`Product not available: ${product.name}`, 'PRODUCT_UNAVAILABLE');
    }
    const unitPriceMinor = item.unitPrice !== undefined ? toMinor(item.unitPrice) : product.sellingPriceMinor;

    let quantity: number;
    let lineTotalMinor: number;
    if (item.amount !== undefined) {
      // Amount-based sale: the customer pays exactly this amount; the quantity to
      // deduct is derived from it. Line total is the amount itself (kept exact),
      // quantity is rounded to 3 dp for a clean inventory movement.
      if (unitPriceMinor <= 0) {
        throw ApiError.badRequest(`Cannot sell ${product.name} by amount — it has no unit price`, 'PRODUCT_NO_PRICE');
      }
      lineTotalMinor = toMinor(item.amount);
      quantity = round3(lineTotalMinor / unitPriceMinor);
    } else {
      quantity = item.quantity!;
      lineTotalMinor = Math.round(unitPriceMinor * quantity);
    }
    return {
      productId: item.productId, name: product.name, unitId: product.unitId, quantity, unitPriceMinor, lineTotalMinor,
      unitCostMinor: productRepo.averageCostMinor(product),
    };
  });
}

/**
 * Create a sale, all-or-nothing (§48).
 *
 * Mongo wrapped Sale + SaleItems + per-item stock deduction + the customer
 * ledger debit in one transaction. DynamoDB cannot span those tables with
 * conditional stock decrements, so atomicity is reconstructed explicitly: each
 * stock deduction hands back an undo handle, and any failure — most commonly one
 * item lacking stock — unwinds every movement already applied, deletes the sale
 * items and removes the sale (releasing its code guard). The observable
 * behaviour is unchanged: books and stock never partially update.
 *
 * The per-item deduction itself is still atomic and guarded, so two concurrent
 * sales cannot both take the last unit.
 */
export async function createSale(ctx: TenantContext, input: CreateSaleInput, userId: string) {
  // Customer is optional (both cash and credit). Validate it only when supplied.
  if (input.customerId) {
    const customer = await customerRepo.findById(ctx.shopId, input.customerId);
    if (!customer) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  }

  // Load products (shop-scoped) and snapshot price/name/unit.
  const prepared = await prepareItems(ctx, input.items);

  const subtotalMinor = prepared.reduce((s, i) => s + i.lineTotalMinor, 0);
  const totalMinor = subtotalMinor; // tax handled per-product later (§7)

  const sale = await saleRepo.create({
    shopId: ctx.shopId,
    code: generateCode('SALE'),
    customerId: input.customerId ?? null,
    customerPhone: input.customerPhone ?? '',
    type: input.type,
    status: SaleStatus.COMPLETED,
    subtotalMinor,
    taxMinor: 0,
    totalMinor,
    paidMinor: input.type === SaleType.CASH ? totalMinor : 0,
    dueMinor: input.type === SaleType.CASH ? 0 : totalMinor,
    paymentMethod: input.type === SaleType.CASH ? (input.paymentMethod ?? 'CASH') : null,
    note: input.note ?? '',
    soldBy: userId,
  });

  const undos: NonNullable<MovementResult['undo']>[] = [];
  try {
    for (const item of prepared) {
      await saleRepo.addItem({
        shopId: ctx.shopId,
        saleId: sale.id,
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        unitId: item.unitId,
        unitPriceMinor: item.unitPriceMinor,
        lineTotalMinor: item.lineTotalMinor,
        unitCostMinor: item.unitCostMinor,
      });
    }

    // Deduct stock for each line (atomic + guarded inside recordMovement).
    for (const item of prepared) {
      const moved = await recordMovement(ctx, {
        productId: item.productId,
        type: InventoryTxnType.SALE,
        quantity: item.quantity,
        refType: RefType.SALE,
        refId: sale.id,
        performedBy: userId,
        note: `Sale ${sale.code}`,
      });
      if (moved.undo) undos.push(moved.undo);
    }

    // Credit sale with a named customer => post the debit to their ledger. A credit
    // sale without a customer keeps its due on the sale record only (unassigned).
    if (input.type === SaleType.CREDIT && input.customerId) {
      await postLedgerEntry(ctx, {
        customerId: input.customerId,
        entryType: LedgerEntryType.CREDIT_SALE,
        debitMinor: totalMinor,
        refType: LedgerRefType.SALE,
        refId: sale.id,
        note: `Sale ${sale.code}`,
        createdBy: userId,
      });
    } else if (input.customerId) {
      await customerRepo.touchLastSale(ctx.shopId, input.customerId);
    }
  } catch (err) {
    // Roll the whole sale back: restore stock, drop the movements, remove the
    // items and the sale itself (which frees its code).
    await undoMovements(ctx, undos);
    await saleRepo.deleteItems(sale.id).catch(() => undefined);
    await saleRepo.hardDelete(sale).catch(() => undefined);
    throw err;
  }

  return sale;
}

/** Attaches customer name/phone, which used to come from a Mongoose populate. */
async function attachCustomers<T extends { customerId: string | null }>(ctx: TenantContext, rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.customerId).filter((v): v is string => !!v))];
  const customers = await Promise.all(ids.map((id) => customerRepo.findById(ctx.shopId, id)));
  const byId = new Map(customers.filter((c) => c !== null).map((c) => [c.id, c]));
  return rows.map((r) => {
    const c = r.customerId ? byId.get(r.customerId) : undefined;
    return { ...r, customerId: c ? { _id: c.id, name: c.name, phone: c.phone } : r.customerId };
  });
}

export async function listSales(
  ctx: TenantContext,
  query: unknown,
  filters: { type?: string; status?: string; customerId?: string; from?: string; to?: string },
) {
  const { page, limit, skip, sort } = parsePagination(query, '-soldAt');
  let rows = filters.customerId
    ? await saleRepo.listByCustomer(ctx.shopId, filters.customerId)
    : await saleRepo.listByShop(ctx.shopId);

  if (filters.type) rows = rows.filter((s) => s.type === filters.type);
  if (filters.status) rows = rows.filter((s) => s.status === filters.status);
  if (filters.from || filters.to) {
    const from = filters.from ? new Date(filters.from).getTime() : -Infinity;
    const to = filters.to ? new Date(filters.to).getTime() : Infinity;
    rows = rows.filter((s) => {
      const t = new Date(s.soldAt).getTime();
      return t >= from && t <= to;
    });
  }

  const { data, total } = paginateInMemory(rows, { skip, limit, sort });

  // Attach line items so the list shows what was sold, not just totals.
  const itemsPerSale = await Promise.all(data.map((s) => saleRepo.listItems(s.id)));
  const withCustomers = await attachCustomers(ctx, data);
  const withItems = withCustomers.map((s, i) => ({ ...s, items: itemsPerSale[i] ?? [] }));

  return { data: withItems, meta: buildPageMeta(page, limit, total) };
}

export async function getSale(ctx: TenantContext, id: string) {
  const found = await saleRepo.findScoped(ctx.shopId, id);
  if (!found) throw ApiError.notFound('Sale not found', 'SALE_NOT_FOUND');
  const [sale] = await attachCustomers(ctx, [found]);
  const items = await saleRepo.listItems(id);
  return { sale: sale!, items };
}

/**
 * Correct a confirmed sale — every field, including Cash ↔ Credit, the customer
 * and the lines. Nothing in the reports is stored pre-computed: dashboards read
 * sales, sale items, the stock ledger and customer ledgers live, so reconciling
 * those four makes every total follow the edit automatically.
 *
 *  - Stock moves by the net change per product only (returns before deductions,
 *    deductions stock-guarded), so a price- or type-only edit touches no stock.
 *  - The customer ledger is append-only: the old credit charge is reversed and the
 *    new one posted, so the customer's history shows the correction.
 *  - The sale keeps its code and sale date.
 *
 * DynamoDB has no cross-table transaction here, so each applied step is recorded
 * and a failure unwinds all of them — the sale, stock and balances are left
 * exactly as they were.
 */
export async function updateSale(ctx: TenantContext, id: string, input: CreateSaleInput, userId: string) {
  const sale = await saleRepo.findScoped(ctx.shopId, id);
  if (!sale) throw ApiError.notFound('Sale not found', 'SALE_NOT_FOUND');
  if (sale.status !== SaleStatus.COMPLETED) {
    throw ApiError.conflict('Only confirmed sales can be edited', 'SALE_NOT_EDITABLE');
  }
  if (input.customerId) {
    const customer = await customerRepo.findById(ctx.shopId, input.customerId);
    if (!customer) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  }

  const oldItems = await saleRepo.listItems(sale.id);
  const prepared = await prepareItems(ctx, input.items, new Set(oldItems.map((i) => i.productId)));
  // A product already on the sale keeps the cost it was sold at — including "none
  // recorded" on lines sold before purchase costing, so their profit is unchanged —
  // and an edit never re-costs past goods. Only newly added products take today's average.
  const soldAtCost = new Map(oldItems.map((i) => [i.productId, i.unitCostMinor]));
  for (const item of prepared) {
    if (soldAtCost.has(item.productId)) item.unitCostMinor = soldAtCost.get(item.productId);
  }
  const subtotalMinor = prepared.reduce((s, i) => s + i.lineTotalMinor, 0);
  const totalMinor = subtotalMinor;
  const isCash = input.type === SaleType.CASH;

  // Net stock change per product: positive = sell more, negative = give back.
  const net = new Map<string, number>();
  for (const i of oldItems) net.set(i.productId, (net.get(i.productId) ?? 0) - i.quantity);
  for (const i of prepared) net.set(i.productId, (net.get(i.productId) ?? 0) + i.quantity);

  const undos: NonNullable<MovementResult['undo']>[] = [];
  const addedItemIds: string[] = [];
  const removedOld: typeof oldItems = [];
  const ledgerPosted: { customerId: string; debitMinor: number; creditMinor: number }[] = [];

  try {
    for (const phase of ['RETURN', 'SALE'] as const) {
      for (const [productId, delta] of net) {
        const q = round3(delta);
        if (phase === 'RETURN' ? q >= 0 : q <= 0) continue;
        const moved = await recordMovement(ctx, {
          productId,
          type: phase === 'RETURN' ? InventoryTxnType.RETURN : InventoryTxnType.SALE,
          quantity: Math.abs(q),
          refType: RefType.SALE,
          refId: sale.id,
          performedBy: userId,
          note: `Edit of ${sale.code}`,
        });
        if (moved.undo) undos.push(moved.undo);
      }
    }

    // New lines first, so the sale is never momentarily without its items.
    for (const item of prepared) {
      const rec = await saleRepo.addItem({
        shopId: ctx.shopId,
        saleId: sale.id,
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        unitId: item.unitId,
        unitPriceMinor: item.unitPriceMinor,
        lineTotalMinor: item.lineTotalMinor,
        unitCostMinor: item.unitCostMinor,
      });
      addedItemIds.push(rec.id);
    }

    // Customer ledger: a credit sale with a customer is a debit on that customer.
    const oldCharge = sale.type === SaleType.CREDIT && sale.customerId ? { customerId: sale.customerId, amount: sale.totalMinor } : null;
    const newCharge = !isCash && input.customerId ? { customerId: input.customerId, amount: totalMinor } : null;
    const unchanged = !!oldCharge && !!newCharge && oldCharge.customerId === newCharge.customerId && oldCharge.amount === newCharge.amount;
    if (!unchanged) {
      // A customer deleted since the sale has no balance left to reverse against.
      if (oldCharge && (await customerRepo.findById(ctx.shopId, oldCharge.customerId))) {
        await postLedgerEntry(ctx, {
          customerId: oldCharge.customerId,
          entryType: LedgerEntryType.REVERSAL,
          creditMinor: oldCharge.amount,
          refType: LedgerRefType.SALE,
          refId: sale.id,
          note: `Edit of ${sale.code}: previous charge reversed`,
          createdBy: userId,
        });
        ledgerPosted.push({ customerId: oldCharge.customerId, debitMinor: oldCharge.amount, creditMinor: 0 });
      }
      if (newCharge) {
        await postLedgerEntry(ctx, {
          customerId: newCharge.customerId,
          entryType: LedgerEntryType.CREDIT_SALE,
          debitMinor: newCharge.amount,
          refType: LedgerRefType.SALE,
          refId: sale.id,
          note: `Sale ${sale.code} (edited)`,
          createdBy: userId,
        });
        ledgerPosted.push({ customerId: newCharge.customerId, debitMinor: 0, creditMinor: newCharge.amount });
      }
    }
    if (isCash && input.customerId) await customerRepo.touchLastSale(ctx.shopId, input.customerId);

    for (const old of oldItems) {
      await saleRepo.removeItem(sale.id, old.id);
      removedOld.push(old);
    }

    return await saleRepo.applyCorrection(sale, {
      customerId: input.customerId ?? null,
      customerPhone: input.customerPhone ?? '',
      type: input.type,
      subtotalMinor,
      taxMinor: 0,
      totalMinor,
      paidMinor: isCash ? totalMinor : 0,
      dueMinor: isCash ? 0 : totalMinor,
      paymentMethod: isCash ? (input.paymentMethod ?? (sale.type === SaleType.CASH ? sale.paymentMethod : null) ?? 'CASH') : null,
      note: input.note ?? sale.note,
      editedBy: userId,
    });
  } catch (err) {
    // Unwind in reverse order. Best-effort: the original error is what's reported.
    for (const old of removedOld) {
      await saleRepo
        .addItem({ shopId: ctx.shopId, saleId: sale.id, productId: old.productId, name: old.name, quantity: old.quantity, unitId: old.unitId, unitPriceMinor: old.unitPriceMinor, lineTotalMinor: old.lineTotalMinor, unitCostMinor: old.unitCostMinor })
        .catch(() => undefined);
    }
    for (const entry of ledgerPosted.reverse()) {
      await postLedgerEntry(ctx, {
        customerId: entry.customerId,
        entryType: LedgerEntryType.ADJUSTMENT,
        debitMinor: entry.debitMinor,
        creditMinor: entry.creditMinor,
        refType: LedgerRefType.SALE,
        refId: sale.id,
        note: `Edit of ${sale.code} failed — rolled back`,
        createdBy: userId,
      }).catch(() => undefined);
    }
    for (const itemId of addedItemIds) await saleRepo.removeItem(sale.id, itemId).catch(() => undefined);
    await undoMovements(ctx, undos);
    throw err;
  }
}

/**
 * Reverse a completed sale (§79): restore stock, credit the customer ledger back,
 * and mark the sale CANCELLED — never delete/edit the original record.
 */
export async function reverseSale(ctx: TenantContext, id: string, userId: string) {
  const sale = await saleRepo.findScoped(ctx.shopId, id);
  if (!sale) throw ApiError.notFound('Sale not found', 'SALE_NOT_FOUND');
  if (sale.status === SaleStatus.CANCELLED) throw ApiError.conflict('Sale already reversed', 'SALE_ALREADY_REVERSED');

  const items = await saleRepo.listItems(id);

  for (const item of items) {
    await recordMovement(ctx, {
      productId: item.productId,
      type: InventoryTxnType.RETURN,
      quantity: item.quantity,
      refType: RefType.SALE,
      refId: sale.id,
      performedBy: userId,
      note: `Reversal of ${sale.code}`,
    });
  }

  if (sale.type === SaleType.CREDIT && sale.customerId) {
    await postLedgerEntry(ctx, {
      customerId: sale.customerId,
      entryType: LedgerEntryType.REVERSAL,
      creditMinor: sale.totalMinor,
      refType: LedgerRefType.SALE,
      refId: sale.id,
      note: `Reversal of ${sale.code}`,
      createdBy: userId,
    });
  }

  return saleRepo.update(ctx.shopId, sale, {
    status: SaleStatus.CANCELLED,
    cancelledAt: new Date().toISOString(),
  });
}
