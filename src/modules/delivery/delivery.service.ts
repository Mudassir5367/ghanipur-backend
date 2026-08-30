import { Types } from 'mongoose';
import { Delivery, DeliveryStatus, PaymentType, DELIVERY_TRANSITIONS, derivePaymentStatus } from '../../models/delivery.model.js';
import { Product } from '../../models/product.model.js';
import { Customer } from '../../models/customer.model.js';
import { Shop } from '../../models/shop.model.js';
import { dayRange } from '../../utils/dateRange.js';
import { ApiError } from '../../utils/ApiError.js';
import { toMinor } from '../../utils/money.js';
import { generateCode } from '../../utils/code.js';
import { parsePagination } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { withTransaction } from '../../utils/withTransaction.js';
import { recordMovement } from '../../services/inventory.service.js';
import { InventoryTxnType, RefType } from '../../constants/inventory.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateDeliveryInput, AddPaymentInput } from './delivery.validators.js';

interface PopulatedProduct {
  _id: Types.ObjectId;
  name: string;
  sku: string;
  sellingPriceMinor: number;
  purchaseCostMinor: number;
  images: string[];
  isAvailable: boolean;
  categoryId?: { name?: string };
  unitId?: { _id: Types.ObjectId; symbol?: string };
}

export async function createDelivery(ctx: TenantContext, input: CreateDeliveryInput, userId: string) {
  let customer = null;
  if (input.customerId) {
    customer = await Customer.findOne({ _id: input.customerId, shopId: ctx.shopId, isDeleted: false });
    if (!customer) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  }

  const products = (await Product.find({ _id: { $in: input.lines.map((l) => l.productId) }, shopId: ctx.shopId, isDeleted: false })
    .populate('categoryId', 'name')
    .populate('unitId', 'symbol')) as unknown as PopulatedProduct[];
  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  const lines = input.lines.map((l) => {
    const p = byId.get(l.productId);
    if (!p) throw ApiError.badRequest(`Product not found: ${l.productId}`, 'PRODUCT_NOT_FOUND');
    const unitPriceMinor = l.unitPrice !== undefined ? toMinor(l.unitPrice) : p.sellingPriceMinor;
    // Per-delivery cost price; falls back to the product's cost when not overridden.
    const costPriceMinor = l.costPrice !== undefined ? toMinor(l.costPrice) : (p.purchaseCostMinor ?? 0);
    const lineTotalMinor = Math.round(unitPriceMinor * l.quantity);
    return {
      productId: p._id,
      name: p.name,
      sku: p.sku,
      category: p.categoryId?.name ?? '',
      imageUrl: p.images?.[0] ?? null,
      quantity: l.quantity,
      unitId: p.unitId?._id ?? null,
      unitSymbol: p.unitId?.symbol ?? '',
      unitPriceMinor,
      costPriceMinor,
      lineTotalMinor,
    };
  });

  // Per-line selling/cost drive the totals (like a walk-in sale). The delivery's total
  // cost is stored so the dashboard profit card can show Selling − Cost per delivery.
  const subtotalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  const costPriceMinor = lines.reduce((s, l) => s + Math.round(l.costPriceMinor * l.quantity), 0);
  const discountMinor = input.discount ? toMinor(input.discount) : 0;
  const deliveryChargeMinor = input.deliveryCharge ? toMinor(input.deliveryCharge) : 0;
  const grandTotalMinor = subtotalMinor + deliveryChargeMinor - discountMinor;
  if (grandTotalMinor < 0) throw ApiError.badRequest('Discount cannot exceed the total', 'INVALID_DISCOUNT');

  // Cash = paid in full; Credit = optional partial payment.
  let paidMinor = input.paymentType === PaymentType.CASH ? grandTotalMinor : input.paidAmount ? toMinor(input.paidAmount) : 0;
  if (paidMinor > grandTotalMinor) throw ApiError.badRequest('Paid amount cannot exceed the grand total', 'OVERPAYMENT');
  if (paidMinor < 0) paidMinor = 0;
  const remainingMinor = grandTotalMinor - paidMinor;

  const payments =
    paidMinor > 0
      ? [{ amountMinor: paidMinor, method: 'CASH', note: 'Initial payment', remainingAfterMinor: remainingMinor, receivedBy: userId, receivedAt: new Date() }]
      : [];

  // A recorded delivery is a committed sale: create it and deduct stock atomically,
  // so remaining stock drops immediately (the reports already count it as a sale).
  // Stock is marked deducted here, so a later CONFIRMED transition won't re-deduct
  // and a CANCELLED transition restores it (see changeStatus). Insufficient stock
  // rolls the whole thing back — no delivery and no stock change.
  return withTransaction(async (session) => {
    const created = await Delivery.create(
      [{
        shopId: ctx.shopId,
        code: generateCode('DEL'),
        customerId: input.customerId ?? null,
        customerName: customer?.name ?? '',
        customerPhone: customer?.phone ?? '',
        lines,
        subtotalMinor,
        costPriceMinor,
        discountMinor,
        deliveryChargeMinor,
        grandTotalMinor,
        paidMinor,
        remainingMinor,
        paymentType: input.paymentType,
        paymentStatus: derivePaymentStatus(grandTotalMinor, paidMinor),
        payments,
        // The roster "one-click deliver" flow saves straight as DELIVERED; otherwise PENDING.
        status: input.deliverNow ? DeliveryStatus.DELIVERED : DeliveryStatus.PENDING,
        inventoryDeducted: true,
        confirmedAt: input.deliverNow ? new Date() : null,
        deliveredAt: input.deliverNow ? new Date() : null,
        assignedToName: input.assignedToName ?? '',
        address: input.address ?? customer?.address ?? '',
        note: input.note ?? '',
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        createdBy: userId,
      }],
      { session },
    );
    const delivery = created[0]!;

    for (const line of delivery.lines) {
      const result = await recordMovement(
        ctx,
        { productId: line.productId.toString(), type: InventoryTxnType.DELIVERY, quantity: line.quantity, refType: RefType.DELIVERY, refId: delivery._id, performedBy: userId, note: `Delivery ${delivery.code}` },
        session,
      );
      if (!result.skipped && result.balanceAfter !== undefined) {
        line.stockAfter = result.balanceAfter;
        line.stockBefore = result.balanceAfter + line.quantity;
      }
    }
    await delivery.save({ session });
    return delivery;
  });
}

/**
 * Edit an existing delivery (admin). Rebuilds the lines/totals from the input and
 * reconciles stock: restore the previously-deducted quantities, then deduct the new
 * ones (guarded, so insufficient stock rolls the whole edit back).
 */
export async function updateDelivery(ctx: TenantContext, id: string, input: CreateDeliveryInput, userId: string) {
  let customer = null;
  if (input.customerId) {
    customer = await Customer.findOne({ _id: input.customerId, shopId: ctx.shopId, isDeleted: false });
    if (!customer) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  }

  const products = (await Product.find({ _id: { $in: input.lines.map((l) => l.productId) }, shopId: ctx.shopId, isDeleted: false })
    .populate('categoryId', 'name')
    .populate('unitId', 'symbol')) as unknown as PopulatedProduct[];
  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  const lines = input.lines.map((l) => {
    const p = byId.get(l.productId);
    if (!p) throw ApiError.badRequest(`Product not found: ${l.productId}`, 'PRODUCT_NOT_FOUND');
    const unitPriceMinor = l.unitPrice !== undefined ? toMinor(l.unitPrice) : p.sellingPriceMinor;
    const costPriceMinor = l.costPrice !== undefined ? toMinor(l.costPrice) : (p.purchaseCostMinor ?? 0);
    const lineTotalMinor = Math.round(unitPriceMinor * l.quantity);
    return {
      productId: p._id, name: p.name, sku: p.sku, category: p.categoryId?.name ?? '', imageUrl: p.images?.[0] ?? null,
      quantity: l.quantity, unitId: p.unitId?._id ?? null, unitSymbol: p.unitId?.symbol ?? '',
      unitPriceMinor, costPriceMinor, lineTotalMinor, stockBefore: null as number | null, stockAfter: null as number | null,
    };
  });

  const subtotalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  const costTotalMinor = lines.reduce((s, l) => s + Math.round(l.costPriceMinor * l.quantity), 0);
  const discountMinor = input.discount ? toMinor(input.discount) : 0;
  const deliveryChargeMinor = input.deliveryCharge ? toMinor(input.deliveryCharge) : 0;
  const grandTotalMinor = subtotalMinor + deliveryChargeMinor - discountMinor;
  if (grandTotalMinor < 0) throw ApiError.badRequest('Discount cannot exceed the total', 'INVALID_DISCOUNT');
  let paidMinor = input.paymentType === PaymentType.CASH ? grandTotalMinor : input.paidAmount ? toMinor(input.paidAmount) : 0;
  if (paidMinor > grandTotalMinor) throw ApiError.badRequest('Paid amount cannot exceed the grand total', 'OVERPAYMENT');
  if (paidMinor < 0) paidMinor = 0;
  const remainingMinor = grandTotalMinor - paidMinor;
  const payments = paidMinor > 0
    ? [{ amountMinor: paidMinor, method: 'CASH', note: 'Payment (edited)', remainingAfterMinor: remainingMinor, receivedBy: userId, receivedAt: new Date() }]
    : [];

  return withTransaction(async (session) => {
    const delivery = await Delivery.findOne({ _id: id, shopId: ctx.shopId }).session(session ?? null);
    if (!delivery) throw ApiError.notFound('Delivery not found', 'DELIVERY_NOT_FOUND');
    if (delivery.status === DeliveryStatus.CANCELLED) throw ApiError.badRequest('Cannot edit a cancelled delivery', 'DELIVERY_CANCELLED');

    // Give back the old stock, then take the new — net change is applied atomically.
    if (delivery.inventoryDeducted) {
      for (const line of delivery.lines) {
        await recordMovement(ctx, { productId: line.productId.toString(), type: InventoryTxnType.RETURN, quantity: line.quantity, refType: RefType.DELIVERY, refId: delivery._id, performedBy: userId, note: `Edit ${delivery.code}` }, session);
      }
    }
    for (const line of lines) {
      const result = await recordMovement(ctx, { productId: line.productId.toString(), type: InventoryTxnType.DELIVERY, quantity: line.quantity, refType: RefType.DELIVERY, refId: delivery._id, performedBy: userId, note: `Delivery ${delivery.code}` }, session);
      if (!result.skipped && result.balanceAfter !== undefined) { line.stockAfter = result.balanceAfter; line.stockBefore = result.balanceAfter + line.quantity; }
    }

    delivery.customerId = (input.customerId ?? null) as unknown as Types.ObjectId;
    delivery.customerName = customer?.name ?? '';
    delivery.customerPhone = customer?.phone ?? '';
    delivery.set('lines', lines);
    delivery.subtotalMinor = subtotalMinor;
    delivery.costPriceMinor = costTotalMinor;
    delivery.discountMinor = discountMinor;
    delivery.deliveryChargeMinor = deliveryChargeMinor;
    delivery.grandTotalMinor = grandTotalMinor;
    delivery.paidMinor = paidMinor;
    delivery.remainingMinor = remainingMinor;
    delivery.paymentType = input.paymentType;
    delivery.paymentStatus = derivePaymentStatus(grandTotalMinor, paidMinor);
    delivery.set('payments', payments);
    delivery.inventoryDeducted = true;
    if (input.deliverNow && delivery.status !== DeliveryStatus.DELIVERED) {
      delivery.status = DeliveryStatus.DELIVERED;
      delivery.deliveredAt = new Date();
      if (!delivery.confirmedAt) delivery.confirmedAt = new Date();
    }
    if (input.assignedToName !== undefined) delivery.assignedToName = input.assignedToName;
    if (input.address !== undefined) delivery.address = input.address;
    if (input.note !== undefined) delivery.note = input.note;
    await delivery.save({ session });
    return delivery;
  });
}

/**
 * Daily delivery roster: every active customer with today's status — DELIVERED if a
 * (non-cancelled) delivery was made for them today, else PENDING. Rolls over at
 * midnight (shop timezone) since "today" moves, and new customers appear automatically.
 */
export async function deliveryRoster(ctx: TenantContext) {
  const shop = await Shop.findById(ctx.shopId, 'timezone');
  const range = dayRange(undefined, shop?.timezone ?? 'Asia/Karachi');
  const customers = await Customer.find({ shopId: ctx.shopId, isDeleted: false }).select('name phone address currentBalanceMinor').sort({ name: 1 }).lean();
  const ids = customers.map((c) => String(c._id));
  const [todays, deliveryDues] = await Promise.all([
    Delivery.find({ shopId: ctx.shopId, status: { $ne: DeliveryStatus.CANCELLED }, createdAt: { $gte: range.start, $lte: range.end } })
      .select('customerId code grandTotalMinor remainingMinor createdAt').sort({ createdAt: -1 }).lean(),
    // Same total-dues source the Customers page uses, so the numbers reconcile.
    outstandingByCustomers(ctx, ids),
  ]);

  // Per customer: the latest today's delivery (for Edit) plus the sum of today's deliveries.
  const today = new Map<string, { latestId: string; latestCode: string; totalMinor: number }>();
  for (const d of todays) {
    if (!d.customerId) continue;
    const key = String(d.customerId);
    const cur = today.get(key);
    if (!cur) today.set(key, { latestId: String(d._id), latestCode: d.code, totalMinor: d.grandTotalMinor }); // sorted desc → first is latest
    else cur.totalMinor += d.grandTotalMinor;
  }

  const rows = customers.map((c) => {
    const key = String(c._id);
    const t = today.get(key);
    // Total owed = ledger balance + all delivery dues (matches the Customers page).
    const outstandingMinor = Math.max(0, c.currentBalanceMinor ?? 0) + (deliveryDues.get(key) ?? 0);
    return {
      customerId: key,
      name: c.name,
      phone: c.phone ?? '',
      address: c.address ?? '',
      outstandingMinor,
      status: t ? 'DELIVERED' : 'PENDING',
      deliveryId: t?.latestId ?? null,
      deliveryCode: t?.latestCode ?? null,
      todayTotalMinor: t?.totalMinor ?? 0,
    };
  });
  return { date: range.start, rows };
}

export async function listDeliveries(ctx: TenantContext, query: unknown, filters: { status?: string; paymentStatus?: string; customerId?: string; from?: string; to?: string }) {
  const { page, limit, skip, sort, search } = parsePagination(query, '-createdAt');
  const filter: Record<string, unknown> = { shopId: ctx.shopId };
  if (filters.status) filter.status = filters.status;
  if (filters.paymentStatus) filter.paymentStatus = filters.paymentStatus;
  if (filters.customerId) filter.customerId = filters.customerId;
  if (filters.from || filters.to) {
    const range: Record<string, Date> = {};
    if (filters.from) range.$gte = new Date(filters.from);
    if (filters.to) range.$lte = new Date(filters.to);
    filter.createdAt = range;
  }
  if (search) filter.$or = [{ code: { $regex: search, $options: 'i' } }, { customerName: { $regex: search, $options: 'i' } }];
  const [data, total] = await Promise.all([
    Delivery.find(filter).sort(sort).skip(skip).limit(limit).populate('customerId', 'name phone'),
    Delivery.countDocuments(filter),
  ]);
  return { data, meta: buildPageMeta(page, limit, total) };
}

export async function getDelivery(ctx: TenantContext, id: string) {
  const delivery = await Delivery.findOne({ _id: id, shopId: ctx.shopId }).populate('customerId', 'name phone address');
  if (!delivery) throw ApiError.notFound('Delivery not found', 'DELIVERY_NOT_FOUND');
  return delivery;
}

/**
 * Change delivery status with inventory side effects (§5, §6, §15):
 *  - CONFIRMED: deduct stock once (guarded, never negative), snapshot before/after.
 *  - CANCELLED: restore stock if it was deducted. Never double-deduct/double-restore.
 */
export async function changeStatus(ctx: TenantContext, id: string, next: DeliveryStatus, userId: string) {
  const delivery = await Delivery.findOne({ _id: id, shopId: ctx.shopId });
  if (!delivery) throw ApiError.notFound('Delivery not found', 'DELIVERY_NOT_FOUND');

  const current = delivery.status as DeliveryStatus;
  if (current === next) return delivery;
  if (!(DELIVERY_TRANSITIONS[current] ?? []).includes(next)) {
    throw ApiError.badRequest(`Cannot change status from ${current} to ${next}`, 'INVALID_TRANSITION');
  }

  return withTransaction(async (session) => {
    if (next === DeliveryStatus.CONFIRMED && !delivery.inventoryDeducted) {
      for (const line of delivery.lines) {
        const result = await recordMovement(
          ctx,
          { productId: line.productId.toString(), type: InventoryTxnType.DELIVERY, quantity: line.quantity, refType: RefType.DELIVERY, refId: delivery._id, performedBy: userId, note: `Delivery ${delivery.code}` },
          session,
        );
        if (!result.skipped && result.balanceAfter !== undefined) {
          line.stockAfter = result.balanceAfter;
          line.stockBefore = result.balanceAfter + line.quantity;
        }
      }
      delivery.inventoryDeducted = true;
      delivery.confirmedAt = new Date();
    }

    if (next === DeliveryStatus.CANCELLED && delivery.inventoryDeducted) {
      for (const line of delivery.lines) {
        await recordMovement(
          ctx,
          { productId: line.productId.toString(), type: InventoryTxnType.RETURN, quantity: line.quantity, refType: RefType.DELIVERY, refId: delivery._id, performedBy: userId, note: `Cancelled delivery ${delivery.code}` },
          session,
        );
      }
      delivery.inventoryDeducted = false;
      delivery.cancelledAt = new Date();
    }

    if (next === DeliveryStatus.DELIVERED) delivery.deliveredAt = new Date();
    delivery.status = next;
    await delivery.save({ session });
    return delivery;
  });
}

/** Record a payment against a delivery (§3, §7). Atomic; blocks overpayment. */
export async function addPayment(ctx: TenantContext, id: string, input: AddPaymentInput, userId: string) {
  const amountMinor = toMinor(input.amount);
  if (amountMinor <= 0) throw ApiError.badRequest('Payment amount must be positive', 'INVALID_AMOUNT');

  const paymentDoc = {
    _id: new Types.ObjectId(),
    amountMinor,
    method: input.method ?? 'CASH',
    note: input.note ?? '',
    receivedBy: new Types.ObjectId(userId),
    receivedAt: new Date(),
    remainingAfterMinor: '$remainingMinor',
  };

  // Single atomic pipeline update: recompute paid/remaining/status and append the
  // payment. The `remainingMinor >= amount` filter blocks overpayment race-free.
  const updated = await Delivery.findOneAndUpdate(
    { _id: id, shopId: ctx.shopId, status: { $ne: DeliveryStatus.CANCELLED }, remainingMinor: { $gte: amountMinor } },
    [
      { $set: { paidMinor: { $add: ['$paidMinor', amountMinor] } } },
      { $set: { remainingMinor: { $subtract: ['$grandTotalMinor', '$paidMinor'] } } },
      {
        $set: {
          paymentStatus: {
            $cond: [{ $lte: ['$remainingMinor', 0] }, 'PAID', { $cond: [{ $lte: ['$paidMinor', 0] }, 'DUE', 'PARTIALLY_PAID'] }],
          },
        },
      },
      { $set: { payments: { $concatArrays: ['$payments', [paymentDoc]] } } },
    ],
    { new: true },
  );

  if (!updated) {
    // Distinguish not-found / cancelled / overpayment.
    const existing = await Delivery.findOne({ _id: id, shopId: ctx.shopId });
    if (!existing) throw ApiError.notFound('Delivery not found', 'DELIVERY_NOT_FOUND');
    if (existing.status === DeliveryStatus.CANCELLED) throw ApiError.badRequest('Cannot pay a cancelled delivery', 'DELIVERY_CANCELLED');
    throw ApiError.badRequest('Payment exceeds the remaining balance', 'OVERPAYMENT');
  }
  return updated;
}

/**
 * Delivery outstanding (Σ remaining of non-cancelled deliveries) per customer.
 * Single source of truth for delivery dues — used by the customer list/detail so
 * outstanding stays consistent with the delivery records everywhere.
 */
export async function outstandingByCustomers(ctx: TenantContext, customerIds: string[]): Promise<Map<string, number>> {
  if (customerIds.length === 0) return new Map();
  const rows = await Delivery.aggregate<{ _id: Types.ObjectId; remaining: number }>([
    {
      $match: {
        shopId: new Types.ObjectId(ctx.shopId),
        customerId: { $in: customerIds.map((id) => new Types.ObjectId(id)) },
        status: { $ne: DeliveryStatus.CANCELLED },
      },
    },
    { $group: { _id: '$customerId', remaining: { $sum: '$remainingMinor' } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.remaining]));
}

/** Customer outstanding across all their (non-cancelled) deliveries (§10). */
export async function customerDeliverySummary(ctx: TenantContext, customerId: string) {
  const oid = new Types.ObjectId(customerId);
  const rows = await Delivery.aggregate<{ grand: number; paid: number; remaining: number; count: number }>([
    { $match: { shopId: new Types.ObjectId(ctx.shopId), customerId: oid, status: { $ne: DeliveryStatus.CANCELLED } } },
    { $group: { _id: null, grand: { $sum: '$grandTotalMinor' }, paid: { $sum: '$paidMinor' }, remaining: { $sum: '$remainingMinor' }, count: { $sum: 1 } } },
  ]);
  const agg = rows[0] ?? { grand: 0, paid: 0, remaining: 0, count: 0 };
  const deliveries = await Delivery.find({ shopId: ctx.shopId, customerId }).sort({ createdAt: -1 }).limit(50);
  return {
    totalPurchasesMinor: agg.grand,
    totalPaidMinor: agg.paid,
    outstandingMinor: agg.remaining,
    deliveryCount: agg.count,
    deliveries,
  };
}
