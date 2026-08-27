import { Sale } from '../../models/sale.model.js';
import { SaleItem } from '../../models/saleItem.model.js';
import { Product } from '../../models/product.model.js';
import { Customer } from '../../models/customer.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { toMinor } from '../../utils/money.js';
import { generateCode } from '../../utils/code.js';
import { parsePagination } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { withTransaction } from '../../utils/withTransaction.js';
import { recordMovement } from '../../services/inventory.service.js';
import { postLedgerEntry } from '../../services/ledger.service.js';
import { InventoryTxnType, RefType } from '../../constants/inventory.js';
import { SaleType, SaleStatus, LedgerEntryType, LedgerRefType } from '../../constants/sales.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateSaleInput } from './sale.validators.js';

interface PreparedItem {
  productId: string;
  name: string;
  unitId: unknown;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

/**
 * Create a sale atomically (§48). One transaction covers: Sale + SaleItems +
 * inventory deduction (per item, concurrency-safe) + — for credit — the customer
 * ledger debit and balance update. Any failure (e.g. insufficient stock) rolls
 * the whole thing back, so books and stock never partially update.
 */
export async function createSale(ctx: TenantContext, input: CreateSaleInput, userId: string) {
  // Customer is optional (both cash and credit). Validate it only when supplied.
  if (input.customerId) {
    const customer = await Customer.findOne({ _id: input.customerId, shopId: ctx.shopId, isDeleted: false });
    if (!customer) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  }

  // Load products (shop-scoped) and snapshot price/name/unit.
  const productIds = input.items.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: productIds }, shopId: ctx.shopId, isDeleted: false });
  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  const prepared: PreparedItem[] = input.items.map((item) => {
    const product = byId.get(item.productId);
    if (!product) throw ApiError.badRequest(`Product not found: ${item.productId}`, 'PRODUCT_NOT_FOUND');
    if (!product.isAvailable) throw ApiError.badRequest(`Product not available: ${product.name}`, 'PRODUCT_UNAVAILABLE');
    const unitPriceMinor = item.unitPrice !== undefined ? toMinor(item.unitPrice) : product.sellingPriceMinor;

    let quantity: number;
    let lineTotalMinor: number;
    if (item.amount !== undefined) {
      // Amount-based sale: the customer pays exactly this amount; the quantity to
      // deduct is derived from it. Line total is the amount itself (kept exact),
      // quantity is rounded to 3 dp for a clean inventory movement.
      if (unitPriceMinor <= 0) throw ApiError.badRequest(`Cannot sell ${product.name} by amount — it has no unit price`, 'PRODUCT_NO_PRICE');
      lineTotalMinor = toMinor(item.amount);
      quantity = Math.round((lineTotalMinor / unitPriceMinor) * 1000) / 1000;
    } else {
      quantity = item.quantity!;
      lineTotalMinor = Math.round(unitPriceMinor * quantity);
    }
    return { productId: item.productId, name: product.name, unitId: product.unitId, quantity, unitPriceMinor, lineTotalMinor };
  });

  const subtotalMinor = prepared.reduce((s, i) => s + i.lineTotalMinor, 0);
  const totalMinor = subtotalMinor; // tax handled per-product later (§7)

  return withTransaction(async (session) => {
    const [sale] = await Sale.create(
      [{
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
      }],
      { session },
    );
    const saleId = sale!._id;

    await SaleItem.create(
      prepared.map((i) => ({ shopId: ctx.shopId, saleId, productId: i.productId, name: i.name, quantity: i.quantity, unitId: i.unitId, unitPriceMinor: i.unitPriceMinor, lineTotalMinor: i.lineTotalMinor })),
      // `ordered: true` is required by Mongoose when creating multiple docs in a session.
      { session, ordered: true },
    );

    // Deduct stock for each line (atomic + guarded inside recordMovement).
    for (const item of prepared) {
      await recordMovement(
        ctx,
        { productId: item.productId, type: InventoryTxnType.SALE, quantity: item.quantity, refType: RefType.SALE, refId: saleId, performedBy: userId, note: `Sale ${sale!.code}` },
        session,
      );
    }

    // Credit sale with a named customer => post the debit to their ledger. A credit
    // sale without a customer keeps its due on the sale record only (unassigned).
    if (input.type === SaleType.CREDIT && input.customerId) {
      await postLedgerEntry(
        ctx,
        { customerId: input.customerId, entryType: LedgerEntryType.CREDIT_SALE, debitMinor: totalMinor, refType: LedgerRefType.SALE, refId: saleId, note: `Sale ${sale!.code}`, createdBy: userId },
        session,
      );
    } else if (input.customerId) {
      await Customer.updateOne({ _id: input.customerId, shopId: ctx.shopId }, { lastSaleAt: new Date() }, { session });
    }

    return sale!;
  });
}

export async function listSales(ctx: TenantContext, query: unknown, filters: { type?: string; status?: string; customerId?: string; from?: string; to?: string }) {
  const { page, limit, skip, sort } = parsePagination(query, '-soldAt');
  const filter: Record<string, unknown> = { shopId: ctx.shopId };
  if (filters.type) filter.type = filters.type;
  if (filters.status) filter.status = filters.status;
  if (filters.customerId) filter.customerId = filters.customerId;
  if (filters.from || filters.to) {
    filter.soldAt = {} as Record<string, Date>;
    if (filters.from) (filter.soldAt as Record<string, Date>).$gte = new Date(filters.from);
    if (filters.to) (filter.soldAt as Record<string, Date>).$lte = new Date(filters.to);
  }
  const [sales, total] = await Promise.all([
    Sale.find(filter).sort(sort).skip(skip).limit(limit).populate('customerId', 'name phone'),
    Sale.countDocuments(filter),
  ]);

  // Attach line items (product name + unit price + qty) so the list can show what
  // was actually sold, not just totals.
  const items = await SaleItem.find({ shopId: ctx.shopId, saleId: { $in: sales.map((s) => s._id) } })
    .select('saleId name quantity unitPriceMinor lineTotalMinor')
    .lean();
  const bySale = new Map<string, typeof items>();
  for (const it of items) {
    const key = it.saleId.toString();
    (bySale.get(key) ?? bySale.set(key, []).get(key)!).push(it);
  }
  const data = sales.map((s) => ({ ...s.toObject(), items: bySale.get(s._id.toString()) ?? [] }));

  return { data, meta: buildPageMeta(page, limit, total) };
}

export async function getSale(ctx: TenantContext, id: string) {
  const sale = await Sale.findOne({ _id: id, shopId: ctx.shopId }).populate('customerId', 'name phone');
  if (!sale) throw ApiError.notFound('Sale not found', 'SALE_NOT_FOUND');
  const items = await SaleItem.find({ shopId: ctx.shopId, saleId: id });
  return { sale, items };
}

/**
 * Reverse a completed sale (§79): restore stock, credit the customer ledger back,
 * and mark the sale CANCELLED — never delete/edit the original record.
 */
export async function reverseSale(ctx: TenantContext, id: string, userId: string) {
  const sale = await Sale.findOne({ _id: id, shopId: ctx.shopId });
  if (!sale) throw ApiError.notFound('Sale not found', 'SALE_NOT_FOUND');
  if (sale.status === SaleStatus.CANCELLED) throw ApiError.conflict('Sale already reversed', 'SALE_ALREADY_REVERSED');

  const items = await SaleItem.find({ shopId: ctx.shopId, saleId: id });

  return withTransaction(async (session) => {
    for (const item of items) {
      await recordMovement(
        ctx,
        { productId: item.productId.toString(), type: InventoryTxnType.RETURN, quantity: item.quantity, refType: RefType.SALE, refId: sale._id, performedBy: userId, note: `Reversal of ${sale.code}` },
        session,
      );
    }

    if (sale.type === SaleType.CREDIT && sale.customerId) {
      await postLedgerEntry(
        ctx,
        { customerId: sale.customerId.toString(), entryType: LedgerEntryType.REVERSAL, creditMinor: sale.totalMinor, refType: LedgerRefType.SALE, refId: sale._id, note: `Reversal of ${sale.code}`, createdBy: userId },
        session,
      );
    }

    sale.status = SaleStatus.CANCELLED;
    sale.cancelledAt = new Date();
    await sale.save({ session });
    return sale;
  });
}
