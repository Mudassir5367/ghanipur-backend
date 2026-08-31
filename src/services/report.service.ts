import * as saleRepo from '../repositories/dynamo/saleRepository.js';
import * as paymentRepo from '../repositories/dynamo/paymentRepository.js';
import * as customerRepo from '../repositories/dynamo/customerRepository.js';
import * as productRepo from '../repositories/dynamo/productRepository.js';
import * as unitRepo from '../repositories/dynamo/unitRepository.js';
import * as deliveryRepo from '../repositories/dynamo/deliveryRepository.js';
import * as txnRepo from '../repositories/dynamo/inventoryTransactionRepository.js';
import * as shopRepo from '../repositories/dynamo/shopRepository.js';
import { DeliveryStatus } from '../repositories/dynamo/deliveryRepository.js';
import { SaleType, SaleStatus } from '../constants/sales.js';
import { InventoryTxnType } from '../constants/inventory.js';
import { dayRange, monthRange, namedRange, type DateRange } from '../utils/dateRange.js';
import type { TenantContext } from '../types/context.js';

/**
 * Reporting over DynamoDB.
 *
 * Mongo did this with aggregation pipelines ($group, $lookup, $unwind).
 * DynamoDB has none of that, so each report Queries the shop's partitions and
 * computes in memory. Every read is shop-scoped by partition key, so the cost is
 * proportional to one tenant's data rather than the whole table — the same
 * property that makes the list endpoints affordable.
 */

const inRange = (at: string | Date, range: DateRange): boolean => {
  const t = new Date(at).getTime();
  return t >= range.start.getTime() && t <= range.end.getTime();
};

async function shopTimezone(shopId: string): Promise<string> {
  const shop = await shopRepo.findById(shopId);
  return shop?.timezone ?? 'Asia/Karachi';
}

/** Sales totals split by cash/credit for a range. */
async function salesTotals(shopId: string, range: DateRange) {
  const sales = (await saleRepo.listByShop(shopId)).filter(
    (s) => s.status === SaleStatus.COMPLETED && inRange(s.soldAt, range),
  );
  const sum = (type: SaleType) =>
    sales.filter((s) => s.type === type).reduce((acc, s) => acc + s.totalMinor, 0);
  const cashMinor = sum(SaleType.CASH);
  const creditMinor = sum(SaleType.CREDIT);
  return { cashMinor, creditMinor, totalMinor: cashMinor + creditMinor, count: sales.length };
}

/**
 * All money actually received in the range, across every channel — otherwise the
 * figure is misleading. Three sources, none overlapping:
 *  1. Cash sales — paid in full at the counter (Sale.paidMinor).
 *  2. Standalone customer payments against the credit ledger.
 *  3. Delivery payments — stored embedded on the delivery, NOT as Payment rows.
 */
async function paymentsTotal(shopId: string, range: DateRange): Promise<number> {
  const [sales, payments, deliveries] = await Promise.all([
    saleRepo.listByShop(shopId),
    paymentRepo.listByShop(shopId),
    deliveryRepo.listByShop(shopId),
  ]);

  const cashSales = sales
    .filter((s) => s.status === SaleStatus.COMPLETED && s.type === SaleType.CASH && inRange(s.soldAt, range))
    .reduce((acc, s) => acc + s.paidMinor, 0);

  const standalone = payments
    .filter((p) => !p.reversedAt && inRange(p.receivedAt, range))
    .reduce((acc, p) => acc + p.amountMinor, 0);

  const deliveryPays = deliveries
    .flatMap((d) => d.payments)
    .filter((p) => inRange(p.receivedAt, range))
    .reduce((acc, p) => acc + p.amountMinor, 0);

  return cashSales + standalone + deliveryPays;
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
  const [customers, deliveries] = await Promise.all([
    customerRepo.listByShop(shopId),
    deliveryRepo.listByShop(shopId),
  ]);
  const liveCustomerIds = new Set(customers.map((c) => c.id));

  const ledger = customers
    .filter((c) => c.currentBalanceMinor > 0)
    .reduce((acc, c) => acc + c.currentBalanceMinor, 0);

  // Only dues belonging to a real, non-deleted customer — a delivery with no (or a
  // removed) customer is owed by nobody and never appears on the Customers page.
  const deliveryDues = deliveries
    .filter((d) => d.status !== DeliveryStatus.CANCELLED && d.remainingMinor > 0)
    .filter((d) => d.customerId && liveCustomerIds.has(d.customerId))
    .reduce((acc, d) => acc + d.remainingMinor, 0);

  return ledger + deliveryDues;
}

interface ProductSalesRow {
  _id: string;
  name: string;
  qty: number;
  revenueMinor: number;
  unit: string;
}

/**
 * Product-wise sold quantity + revenue for a range. Combines counter/credit sales
 * with deliveries (goods leave on delivery too), merged per product so quantities
 * can be reported per measurement unit.
 */
async function productSales(shopId: string, range: DateRange): Promise<ProductSalesRow[]> {
  const [sales, deliveries, units] = await Promise.all([
    saleRepo.listByShop(shopId),
    deliveryRepo.listByShop(shopId),
    unitRepo.listForShop(shopId),
  ]);
  const unitSymbol = new Map(units.map((u) => [u.id, u.symbol]));

  const relevant = sales.filter((s) => s.status === SaleStatus.COMPLETED && inRange(s.soldAt, range));
  const itemsPerSale = await Promise.all(relevant.map((s) => saleRepo.listItems(s.id)));

  const byProduct = new Map<string, ProductSalesRow>();
  const add = (row: ProductSalesRow) => {
    const existing = byProduct.get(row._id);
    if (existing) {
      existing.qty += row.qty;
      existing.revenueMinor += row.revenueMinor;
      if (!existing.unit) existing.unit = row.unit;
    } else {
      byProduct.set(row._id, { ...row });
    }
  };

  for (const item of itemsPerSale.flat()) {
    add({
      _id: item.productId,
      name: item.name,
      qty: item.quantity,
      revenueMinor: item.lineTotalMinor,
      unit: unitSymbol.get(item.unitId) ?? '',
    });
  }

  // Delivered goods (same window/status the revenue & profit cards use).
  for (const d of deliveries) {
    if (d.status === DeliveryStatus.CANCELLED || !inRange(d.createdAt, range)) continue;
    for (const line of d.lines) {
      add({
        _id: line.productId,
        name: line.name,
        qty: line.quantity,
        revenueMinor: line.lineTotalMinor,
        unit: line.unitSymbol,
      });
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
  const rows = await txnRepo.listByShopType(shopId, InventoryTxnType.WASTAGE);
  return rows
    .filter((r) => inRange(r.occurredAt, range))
    .reduce((acc, r) => acc + Math.abs(r.quantity), 0);
}

async function inventorySnapshot(shopId: string) {
  const products = (await productRepo.listByShop(shopId)).filter((p) => p.trackInventory);
  return {
    stockValueMinor: products.reduce((s, p) => s + p.currentStock * p.purchaseCostMinor, 0),
    // Value of remaining stock at selling price — the "price" of what's on hand.
    stockSellValueMinor: products.reduce((s, p) => s + p.currentStock * p.sellingPriceMinor, 0),
    lowStock: products.filter((p) => p.currentStock <= p.minStock).length,
    tracked: products.length,
  };
}

/** Dues that arose from transactions dated within the range (today): sale dues + delivery dues. */
async function outstandingInRange(shopId: string, range: DateRange): Promise<number> {
  const [sales, deliveries] = await Promise.all([
    saleRepo.listByShop(shopId),
    deliveryRepo.listByShop(shopId),
  ]);
  const saleDues = sales
    .filter((s) => s.status === SaleStatus.COMPLETED && s.dueMinor > 0 && inRange(s.soldAt, range))
    .reduce((acc, s) => acc + s.dueMinor, 0);
  const deliveryDues = deliveries
    .filter((d) => d.status !== DeliveryStatus.CANCELLED && d.remainingMinor > 0 && inRange(d.createdAt, range))
    .reduce((acc, d) => acc + d.remainingMinor, 0);
  return saleDues + deliveryDues;
}

/** Remaining stock across all tracked products, summed per unit (L, kg, pcs …). */
async function stockByUnit(shopId: string) {
  const [products, units] = await Promise.all([productRepo.listByShop(shopId), unitRepo.listForShop(shopId)]);
  const unitSymbol = new Map(units.map((u) => [u.id, u.symbol]));
  const byUnit = new Map<string, { qty: number; products: number }>();
  for (const p of products.filter((x) => x.trackInventory)) {
    const key = unitSymbol.get(p.unitId) || 'unit';
    const cur = byUnit.get(key) ?? { qty: 0, products: 0 };
    cur.qty += p.currentStock;
    cur.products += 1;
    byUnit.set(key, cur);
  }
  return [...byUnit.entries()]
    .map(([unit, v]) => ({ unit, qty: v.qty, products: v.products }))
    .sort((a, b) => b.qty - a.qty);
}

/**
 * Gross profit for a range (or all-time when no range): revenue from completed
 * sales minus cost of goods sold. COGS = Σ quantity × the product's current
 * purchase/cost price. Cancelled/reversed sales are excluded.
 */
async function profitForRange(shopId: string, range?: DateRange) {
  const [sales, deliveries, products] = await Promise.all([
    saleRepo.listByShop(shopId),
    deliveryRepo.listByShop(shopId),
    productRepo.listByShop(shopId),
  ]);
  const costById = new Map(products.map((p) => [p.id, p.purchaseCostMinor]));

  const relevant = sales.filter(
    (s) => s.status === SaleStatus.COMPLETED && (!range || inRange(s.soldAt, range)),
  );
  const items = (await Promise.all(relevant.map((s) => saleRepo.listItems(s.id)))).flat();

  const saleRevenue = items.reduce((s, i) => s + i.lineTotalMinor, 0);
  const saleCost = items.reduce((s, i) => s + i.quantity * (costById.get(i.productId) ?? 0), 0);

  // Deliveries (goods sold on delivery — profit is realized regardless of payment).
  // Per-delivery profit = Selling (subtotal) − Cost (costPriceMinor).
  const liveDeliveries = deliveries.filter(
    (d) => d.status !== DeliveryStatus.CANCELLED && (!range || inRange(d.createdAt, range)),
  );
  const deliveryRevenue = liveDeliveries.reduce((s, d) => s + d.subtotalMinor, 0);
  const deliveryCost = liveDeliveries.reduce((s, d) => s + d.costPriceMinor, 0);

  const revenueMinor = saleRevenue + deliveryRevenue;
  const costMinor = saleCost + deliveryCost;
  return { revenueMinor, costMinor, profitMinor: revenueMinor - costMinor };
}

/** Profit & Loss across all products: all-time plus daily / weekly / monthly windows. */
export async function profitLoss(ctx: TenantContext) {
  const tz = await shopTimezone(ctx.shopId);
  const now = new Date();
  const startDaysAgo = (n: number) => {
    const d = new Date(now);
    d.setDate(now.getDate() - n);
    d.setHours(0, 0, 0, 0);
    return d;
  };
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

async function deliveryCount(shopId: string, range: DateRange): Promise<number> {
  const rows = await deliveryRepo.listByShop(shopId);
  return rows.filter((d) => inRange(d.createdAt, range)).length;
}

// ---- Public report methods ----

export async function dashboard(ctx: TenantContext, rangeKey?: string) {
  const tz = await shopTimezone(ctx.shopId);
  const range = namedRange(rangeKey, tz);
  const [sales, payments, outstanding, todayOutstanding, products, inventory, deliveries, stockUnits] =
    await Promise.all([
      salesTotals(ctx.shopId, range),
      paymentsTotal(ctx.shopId, range),
      outstandingTotal(ctx.shopId),
      outstandingInRange(ctx.shopId, range), // dues arising today only
      productSales(ctx.shopId, range),
      inventorySnapshot(ctx.shopId),
      deliveryCount(ctx.shopId, range),
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
    deliveryCount(ctx.shopId, range),
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

  const [products, units] = await Promise.all([
    productRepo.listByShop(ctx.shopId),
    unitRepo.listForShop(ctx.shopId),
  ]);
  const tracked = products.filter((p) => p.trackInventory);
  const unitSymbol = new Map(units.map((u) => [u.id, u.symbol]));

  // One ledger read per product — the ledger is partitioned by productId, so this
  // is a point Query each rather than a table-wide scan.
  const ledgers = await Promise.all(tracked.map((p) => txnRepo.listByProduct(p.id)));

  const rows = tracked.map((p, i) => {
    const entries = (ledgers[i] ?? []).filter((e) => e.shopId === ctx.shopId);

    // Opening = balanceAfter of the most recent movement before the window.
    const before = entries
      .filter((e) => new Date(e.occurredAt).getTime() < range.start.getTime())
      .sort((a, b) => b.sk.localeCompare(a.sk));
    const opening = before[0]?.balanceAfter ?? 0;

    const within = entries.filter((e) => inRange(e.occurredAt, range));
    const byType = within.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + e.quantity;
      return acc;
    }, {});

    const stockIn =
      (byType[InventoryTxnType.STOCK_IN] ?? 0) +
      (byType[InventoryTxnType.PRODUCTION] ?? 0) +
      (byType[InventoryTxnType.RETURN] ?? 0);
    const sold = Math.abs(byType[InventoryTxnType.SALE] ?? 0);
    const wastage = Math.abs(byType[InventoryTxnType.WASTAGE] ?? 0);
    const adjustment = byType[InventoryTxnType.ADJUSTMENT] ?? 0;
    const net = Object.values(byType).reduce((s, q) => s + q, 0);

    return {
      productId: p.id,
      name: p.name,
      unit: unitSymbol.get(p.unitId) ?? '',
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
  // DynamoDB has no aggregation pipeline and no cross-tenant Query, so the
  // per-shop totals are summed from each shop's own partition. Shops are
  // low-cardinality (one row per business), which keeps this bounded.
  const liveShops = await shopRepo.listAllActive();

  const perShop = await Promise.all(
    liveShops.map(async (shop) => {
      const sales = (await saleRepo.listByShop(shop.id)).filter((s) => s.status === SaleStatus.COMPLETED);
      return { count: sales.length, revenue: sales.reduce((s, x) => s + x.totalMinor, 0) };
    }),
  );

  const byStatus = liveShops.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    totalShops: liveShops.length,
    activeShops: byStatus.ACTIVE ?? 0,
    pendingShops: byStatus.PENDING ?? 0,
    suspendedShops: byStatus.SUSPENDED ?? 0,
    totalSales: perShop.reduce((s, p) => s + p.count, 0),
    totalRevenueMinor: perShop.reduce((s, p) => s + p.revenue, 0),
  };
}
