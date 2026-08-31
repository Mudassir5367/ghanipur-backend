import { Types } from 'mongoose';
import { Sale } from '../models/sale.model.js';
import { SaleItem } from '../models/saleItem.model.js';
import { Payment } from '../models/payment.model.js';
import { Customer } from '../models/customer.model.js';
import { Product } from '../models/product.model.js';
import { Delivery, DeliveryStatus } from '../models/delivery.model.js';
import { InventoryTransaction } from '../models/inventoryTransaction.model.js';
import * as shopRepo from '../repositories/dynamo/shopRepository.js';
import { SaleType, SaleStatus } from '../constants/sales.js';
import { InventoryTxnType } from '../constants/inventory.js';
import { dayRange, monthRange, namedRange, type DateRange } from '../utils/dateRange.js';
import type { TenantContext } from '../types/context.js';

const oid = (id: string) => new Types.ObjectId(id);

async function shopTimezone(shopId: string): Promise<string> {
  const shop = await shopRepo.findById(shopId);
  return shop?.timezone ?? 'Asia/Karachi';
}

/** Sales totals split by cash/credit for a range. */
async function salesTotals(shopId: string, range: DateRange) {
  const rows = await Sale.aggregate<{ _id: string; total: number; count: number }>([
    { $match: { shopId: oid(shopId), status: SaleStatus.COMPLETED, soldAt: { $gte: range.start, $lte: range.end } } },
    { $group: { _id: '$type', total: { $sum: '$totalMinor' }, count: { $sum: 1 } } },
  ]);
  const cash = rows.find((r) => r._id === SaleType.CASH);
  const credit = rows.find((r) => r._id === SaleType.CREDIT);
  return {
    cashMinor: cash?.total ?? 0,
    creditMinor: credit?.total ?? 0,
    totalMinor: (cash?.total ?? 0) + (credit?.total ?? 0),
    count: (cash?.count ?? 0) + (credit?.count ?? 0),
  };
}

/**
 * All money actually received in the range, across every channel — otherwise the
 * figure is misleading. Three sources, none overlapping:
 *  1. Cash sales — paid in full at the counter (Sale.paidMinor).
 *  2. Standalone customer payments against the credit ledger (Payment docs).
 *  3. Delivery payments — stored embedded on the delivery, NOT in Payment (this was
 *     silently omitted before, so delivery collections never showed up).
 */
async function paymentsTotal(shopId: string, range: DateRange): Promise<number> {
  const inRange = { $gte: range.start, $lte: range.end };
  const [cashSales, standalone, deliveryPays] = await Promise.all([
    Sale.aggregate<{ total: number }>([
      { $match: { shopId: oid(shopId), status: SaleStatus.COMPLETED, type: SaleType.CASH, soldAt: inRange } },
      { $group: { _id: null, total: { $sum: '$paidMinor' } } },
    ]),
    Payment.aggregate<{ total: number }>([
      { $match: { shopId: oid(shopId), reversedAt: null, receivedAt: inRange } },
      { $group: { _id: null, total: { $sum: '$amountMinor' } } },
    ]),
    Delivery.aggregate<{ total: number }>([
      { $match: { shopId: oid(shopId) } },
      { $unwind: '$payments' },
      { $match: { 'payments.receivedAt': inRange } },
      { $group: { _id: null, total: { $sum: '$payments.amountMinor' } } },
    ]),
  ]);
  return (cashSales[0]?.total ?? 0) + (standalone[0]?.total ?? 0) + (deliveryPays[0]?.total ?? 0);
}

/**
 * Total money customers owe the shop, matching the Customers page exactly (§10,
 * single source of truth): sales credit ledger + delivery dues, per customer.
 * Ledger balances are clamped to >=0 so a customer advance never hides dues owed
 * elsewhere. Credit sales left UNASSIGNED to a customer are deliberately excluded
 * — they belong to nobody, so counting them here would make this total disagree
 * with the sum of the customer rows. Their due still shows on the Sales list.
 */
async function outstandingTotal(shopId: string): Promise<number> {
  const [ledger, deliveries] = await Promise.all([
    Customer.aggregate<{ total: number }>([
      { $match: { shopId: oid(shopId), isDeleted: false, currentBalanceMinor: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$currentBalanceMinor' } } },
    ]),
    Delivery.aggregate<{ total: number }>([
      { $match: { shopId: oid(shopId), status: { $ne: DeliveryStatus.CANCELLED }, remainingMinor: { $gt: 0 } } },
      // Only count dues that belong to a real, non-deleted customer — a delivery
      // with no (or a removed) customer is owed by nobody and never appears on the
      // Customers page, so counting it here would make the two totals disagree.
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'cust' } },
      { $unwind: '$cust' },
      { $match: { 'cust.isDeleted': false } },
      { $group: { _id: null, total: { $sum: '$remainingMinor' } } },
    ]),
  ]);
  return (ledger[0]?.total ?? 0) + (deliveries[0]?.total ?? 0);
}

/** Product-wise sold quantity + revenue for a range. Combines counter/credit
 *  sales (SaleItem) with deliveries (goods leave on delivery too), merged per
 *  product, so quantities can be reported per measurement unit. */
async function productSales(shopId: string, range: DateRange) {
  type Row = { _id: Types.ObjectId; name: string; qty: number; revenueMinor: number; unit: string };
  const [saleRows, deliveryRows] = await Promise.all([
    SaleItem.aggregate<Row>([
      { $match: { shopId: oid(shopId) } },
      { $lookup: { from: 'sales', localField: 'saleId', foreignField: '_id', as: 'sale' } },
      { $unwind: '$sale' },
      { $match: { 'sale.status': SaleStatus.COMPLETED, 'sale.soldAt': { $gte: range.start, $lte: range.end } } },
      { $lookup: { from: 'units', localField: 'unitId', foreignField: '_id', as: 'unit' } },
      { $unwind: { path: '$unit', preserveNullAndEmptyArrays: true } },
      { $group: { _id: '$productId', name: { $first: '$name' }, qty: { $sum: '$quantity' }, revenueMinor: { $sum: '$lineTotalMinor' }, unit: { $first: '$unit.symbol' } } },
    ]),
    // Delivered goods (same window/status the revenue & profit cards use).
    Delivery.aggregate<Row>([
      { $match: { shopId: oid(shopId), status: { $ne: DeliveryStatus.CANCELLED }, createdAt: { $gte: range.start, $lte: range.end } } },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, qty: { $sum: '$lines.quantity' }, revenueMinor: { $sum: '$lines.lineTotalMinor' }, unit: { $first: '$lines.unitSymbol' } } },
    ]),
  ]);

  // Merge the two sources per product (a product can be both sold and delivered).
  const byProduct = new Map<string, Row>();
  for (const r of [...saleRows, ...deliveryRows]) {
    const key = String(r._id);
    const existing = byProduct.get(key);
    if (existing) {
      existing.qty += r.qty;
      existing.revenueMinor += r.revenueMinor;
      if (!existing.unit) existing.unit = r.unit;
    } else {
      byProduct.set(key, { _id: r._id, name: r.name, qty: r.qty, revenueMinor: r.revenueMinor, unit: r.unit });
    }
  }
  return [...byProduct.values()].sort((a, b) => b.revenueMinor - a.revenueMinor);
}

/**
 * Quantities sold summed **per unit** (L, kg, pcs …). A single scalar total mixes
 * incompatible units, so callers get one entry per unit instead.
 */
function quantityByUnit(products: { qty: number; unit?: string }[]) {
  const byUnit = new Map<string, number>();
  for (const p of products) {
    const unit = p.unit || 'unit';
    byUnit.set(unit, (byUnit.get(unit) ?? 0) + p.qty);
  }
  return [...byUnit.entries()].map(([unit, qty]) => ({ unit, qty })).sort((a, b) => b.qty - a.qty);
}

async function wastageTotal(shopId: string, range: DateRange): Promise<number> {
  const rows = await InventoryTransaction.aggregate<{ total: number }>([
    { $match: { shopId: oid(shopId), type: InventoryTxnType.WASTAGE, occurredAt: { $gte: range.start, $lte: range.end } } },
    { $group: { _id: null, total: { $sum: { $abs: '$quantity' } } } },
  ]);
  return rows[0]?.total ?? 0;
}

async function inventorySnapshot(shopId: string) {
  const rows = await Product.aggregate<{ stockValueMinor: number; stockSellValueMinor: number; lowStock: number; tracked: number }>([
    { $match: { shopId: oid(shopId), isDeleted: false, trackInventory: true } },
    {
      $group: {
        _id: null,
        stockValueMinor: { $sum: { $multiply: ['$currentStock', '$purchaseCostMinor'] } },
        // Value of remaining stock at selling price — the "price" of what's on hand.
        stockSellValueMinor: { $sum: { $multiply: ['$currentStock', '$sellingPriceMinor'] } },
        lowStock: { $sum: { $cond: [{ $lte: ['$currentStock', '$minStock'] }, 1, 0] } },
        tracked: { $sum: 1 },
      },
    },
  ]);
  return rows[0] ?? { stockValueMinor: 0, stockSellValueMinor: 0, lowStock: 0, tracked: 0 };
}

/** Dues that arose from transactions dated within the range (today): sale dues + delivery dues. */
async function outstandingInRange(shopId: string, range: DateRange): Promise<number> {
  const [saleRows, deliveryRows] = await Promise.all([
    Sale.aggregate<{ total: number }>([
      { $match: { shopId: oid(shopId), status: SaleStatus.COMPLETED, soldAt: { $gte: range.start, $lte: range.end }, dueMinor: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$dueMinor' } } },
    ]),
    Delivery.aggregate<{ total: number }>([
      { $match: { shopId: oid(shopId), status: { $ne: DeliveryStatus.CANCELLED }, createdAt: { $gte: range.start, $lte: range.end }, remainingMinor: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$remainingMinor' } } },
    ]),
  ]);
  return (saleRows[0]?.total ?? 0) + (deliveryRows[0]?.total ?? 0);
}

/** Remaining stock across all tracked products, summed per unit (L, kg, pcs …). */
async function stockByUnit(shopId: string) {
  const rows = await Product.aggregate<{ _id: string | null; qty: number; count: number }>([
    { $match: { shopId: oid(shopId), isDeleted: false, trackInventory: true } },
    { $lookup: { from: 'units', localField: 'unitId', foreignField: '_id', as: 'unit' } },
    { $unwind: { path: '$unit', preserveNullAndEmptyArrays: true } },
    { $group: { _id: '$unit.symbol', qty: { $sum: '$currentStock' }, count: { $sum: 1 } } },
    { $sort: { qty: -1 } },
  ]);
  return rows.map((r) => ({ unit: r._id || 'unit', qty: r.qty, products: r.count }));
}

/**
 * Gross profit for a range (or all-time when no range): revenue from completed
 * sales minus cost of goods sold. COGS = Σ quantity × the product's current
 * purchase/cost price. Cancelled/reversed sales are excluded.
 */
async function profitForRange(shopId: string, range?: DateRange) {
  const saleMatch: Record<string, unknown> = { 'sale.status': SaleStatus.COMPLETED };
  if (range) saleMatch['sale.soldAt'] = { $gte: range.start, $lte: range.end };
  const deliveryMatch: Record<string, unknown> = { shopId: oid(shopId), status: { $ne: DeliveryStatus.CANCELLED } };
  if (range) deliveryMatch.createdAt = { $gte: range.start, $lte: range.end };

  const [saleRows, deliveryRows] = await Promise.all([
    // Counter/credit sales.
    SaleItem.aggregate<{ revenue: number; cost: number }>([
      { $match: { shopId: oid(shopId) } },
      { $lookup: { from: 'sales', localField: 'saleId', foreignField: '_id', as: 'sale' } },
      { $unwind: '$sale' },
      { $match: saleMatch },
      { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      { $group: { _id: null, revenue: { $sum: '$lineTotalMinor' }, cost: { $sum: { $multiply: ['$quantity', '$product.purchaseCostMinor'] } } } },
    ]),
    // Deliveries (goods sold on delivery — profit is realized regardless of payment).
    // Per-delivery profit = Selling (subtotal) − Cost (costPriceMinor).
    Delivery.aggregate<{ revenue: number; cost: number }>([
      { $match: deliveryMatch },
      { $group: { _id: null, revenue: { $sum: '$subtotalMinor' }, cost: { $sum: '$costPriceMinor' } } },
    ]),
  ]);

  const revenueMinor = (saleRows[0]?.revenue ?? 0) + (deliveryRows[0]?.revenue ?? 0);
  const costMinor = (saleRows[0]?.cost ?? 0) + (deliveryRows[0]?.cost ?? 0);
  return { revenueMinor, costMinor, profitMinor: revenueMinor - costMinor };
}

/** Profit & Loss across all products: all-time plus daily / weekly / monthly windows. */
export async function profitLoss(ctx: TenantContext) {
  const tz = await shopTimezone(ctx.shopId);
  const now = new Date();
  const startDaysAgo = (n: number) => { const d = new Date(now); d.setDate(now.getDate() - n); d.setHours(0, 0, 0, 0); return d; };
  const today = dayRange(undefined, tz);
  const week: DateRange = { start: startDaysAgo(6), end: now };
  const month: DateRange = { start: startDaysAgo(29), end: now };

  const [overall, daily, weekly, monthly] = await Promise.all([
    profitForRange(ctx.shopId),
    profitForRange(ctx.shopId, today),
    profitForRange(ctx.shopId, week),
    profitForRange(ctx.shopId, month),
  ]);
  return { overall, daily, weekly, monthly };
}

// ---- Public report methods ----

export async function dashboard(ctx: TenantContext, rangeKey?: string) {
  const tz = await shopTimezone(ctx.shopId);
  const range = namedRange(rangeKey, tz);
  const [sales, payments, outstanding, todayOutstanding, products, inventory, deliveries, stockUnits] = await Promise.all([
    salesTotals(ctx.shopId, range),
    paymentsTotal(ctx.shopId, range),
    outstandingTotal(ctx.shopId),
    outstandingInRange(ctx.shopId, range), // dues arising today only
    productSales(ctx.shopId, range),
    inventorySnapshot(ctx.shopId),
    Delivery.countDocuments({ shopId: ctx.shopId, createdAt: { $gte: range.start, $lte: range.end } }),
    stockByUnit(ctx.shopId),
  ]);
  const qtySold = products.reduce((s, p) => s + p.qty, 0);
  return {
    range: rangeKey ?? 'today',
    sales,
    paymentsReceivedMinor: payments,
    outstandingMinor: outstanding,
    todayOutstandingMinor: todayOutstanding, // today's dues only (not the all-time balance)
    qtySold,
    // Per-unit breakdown so a mixed catalogue (litres, kg, pieces) reads correctly.
    qtyByUnit: quantityByUnit(products),
    topProducts: products.slice(0, 5),
    stockValueMinor: inventory.stockValueMinor,
    stockSellValueMinor: inventory.stockSellValueMinor, // remaining stock at selling price
    stockByUnit: stockUnits, // remaining stock per unit
    trackedProducts: inventory.tracked,
    lowStockCount: inventory.lowStock,
    deliveries,
  };
}

export async function daily(ctx: TenantContext, dateStr?: string) {
  const tz = await shopTimezone(ctx.shopId);
  const range = dayRange(dateStr, tz);
  const [sales, payments, outstanding, products, wastage, deliveries] = await Promise.all([
    salesTotals(ctx.shopId, range),
    paymentsTotal(ctx.shopId, range),
    outstandingTotal(ctx.shopId),
    productSales(ctx.shopId, range),
    wastageTotal(ctx.shopId, range),
    Delivery.countDocuments({ shopId: ctx.shopId, createdAt: { $gte: range.start, $lte: range.end } }),
  ]);
  return {
    date: dateStr ?? new Date().toISOString().slice(0, 10),
    sales,
    paymentsReceivedMinor: payments,
    outstandingMinor: outstanding,
    qtySold: products.reduce((s, p) => s + p.qty, 0),
    qtyByUnit: quantityByUnit(products),
    products,
    wastageQty: wastage,
    deliveries,
  };
}

export async function monthly(ctx: TenantContext, monthStr?: string) {
  const tz = await shopTimezone(ctx.shopId);
  const range = monthRange(monthStr, tz);
  const [sales, payments, outstanding, products] = await Promise.all([
    salesTotals(ctx.shopId, range),
    paymentsTotal(ctx.shopId, range),
    outstandingTotal(ctx.shopId),
    productSales(ctx.shopId, range),
  ]);
  return {
    month: monthStr ?? new Date().toISOString().slice(0, 7),
    sales,
    paymentsReceivedMinor: payments,
    outstandingMinor: outstanding,
    revenueMinor: sales.totalMinor,
    products,
  };
}

/**
 * Daily milk / inventory management (§10). Per tracked product: opening stock,
 * stock in, sold, wastage, adjustments and closing — all derived from the ledger,
 * so nothing is manually calculated.
 */
export async function dailyMilk(ctx: TenantContext, dateStr?: string) {
  const tz = await shopTimezone(ctx.shopId);
  const range = dayRange(dateStr, tz);

  const [openings, movements, products] = await Promise.all([
    InventoryTransaction.aggregate<{ _id: Types.ObjectId; opening: number }>([
      { $match: { shopId: oid(ctx.shopId), occurredAt: { $lt: range.start } } },
      { $sort: { occurredAt: -1, _id: -1 } },
      { $group: { _id: '$productId', opening: { $first: '$balanceAfter' } } },
    ]),
    InventoryTransaction.aggregate<{ _id: { p: Types.ObjectId; t: string }; qty: number }>([
      { $match: { shopId: oid(ctx.shopId), occurredAt: { $gte: range.start, $lte: range.end } } },
      { $group: { _id: { p: '$productId', t: '$type' }, qty: { $sum: '$quantity' } } },
    ]),
    Product.find({ shopId: ctx.shopId, isDeleted: false, trackInventory: true }).populate('unitId', 'symbol'),
  ]);

  const openingMap = new Map(openings.map((o) => [o._id.toString(), o.opening]));
  const moveMap = new Map<string, Record<string, number>>();
  for (const m of movements) {
    const pid = m._id.p.toString();
    const rec = moveMap.get(pid) ?? {};
    rec[m._id.t] = m.qty;
    moveMap.set(pid, rec);
  }

  const rows = products.map((p) => {
    const pid = p._id.toString();
    const opening = openingMap.get(pid) ?? 0;
    const mv = moveMap.get(pid) ?? {};
    const stockIn = (mv[InventoryTxnType.STOCK_IN] ?? 0) + (mv[InventoryTxnType.PRODUCTION] ?? 0) + (mv[InventoryTxnType.RETURN] ?? 0);
    const sold = Math.abs(mv[InventoryTxnType.SALE] ?? 0);
    const wastage = Math.abs(mv[InventoryTxnType.WASTAGE] ?? 0);
    const adjustment = mv[InventoryTxnType.ADJUSTMENT] ?? 0;
    const net = Object.values(mv).reduce((s, q) => s + q, 0);
    return {
      productId: pid,
      name: p.name,
      unit: (p.unitId as unknown as { symbol?: string })?.symbol ?? '',
      opening,
      stockIn,
      sold,
      wastage,
      adjustment,
      closing: opening + net,
    };
  });

  return { date: dateStr ?? new Date().toISOString().slice(0, 10), rows };
}

/** Platform-wide overview for the super admin (§29). */
export async function platformOverview() {
  const [liveShops, revenueAgg, salesCount] = await Promise.all([
    // DynamoDB has no aggregation pipeline; shops are low-cardinality (one row
    // per business), so the counts are tallied from the byStatus index reads.
    shopRepo.listAllActive(),
    Sale.aggregate<{ total: number }>([
      { $match: { status: SaleStatus.COMPLETED } },
      { $group: { _id: null, total: { $sum: '$totalMinor' } } },
    ]),
    Sale.countDocuments({ status: SaleStatus.COMPLETED }),
  ]);
  const byStatus = liveShops.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});
  const totalShops = liveShops.length;
  return {
    totalShops,
    activeShops: byStatus.ACTIVE ?? 0,
    pendingShops: byStatus.PENDING ?? 0,
    suspendedShops: byStatus.SUSPENDED ?? 0,
    totalSales: salesCount,
    totalRevenueMinor: revenueAgg[0]?.total ?? 0,
  };
}
