import * as deliveryRepo from '../../repositories/dynamo/deliveryRepository.js';
import {
  DeliveryStatus,
  PaymentType,
  DELIVERY_TRANSITIONS,
  derivePaymentStatus,
  type DeliveryLine,
  type DeliveryRecord,
} from '../../repositories/dynamo/deliveryRepository.js';
import * as productRepo from '../../repositories/dynamo/productRepository.js';
import * as categoryRepo from '../../repositories/dynamo/categoryRepository.js';
import * as unitRepo from '../../repositories/dynamo/unitRepository.js';
import * as customerRepo from '../../repositories/dynamo/customerRepository.js';
import * as shopRepo from '../../repositories/dynamo/shopRepository.js';
import { dayRange } from '../../utils/dateRange.js';
import { ApiError } from '../../utils/ApiError.js';
import { toMinor } from '../../utils/money.js';
import { generateCode } from '../../utils/code.js';
import { parsePagination, paginateInMemory } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { recordMovement, undoMovements, type MovementResult } from '../../services/inventory.service.js';
import { InventoryTxnType, RefType } from '../../constants/inventory.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateDeliveryInput, AddPaymentInput } from './delivery.validators.js';

export { DeliveryStatus, PaymentType };

/**
 * Builds the snapshot lines for a delivery (§14): name, sku, category, unit and
 * both prices are frozen at delivery time and never joined back to the product.
 */
async function buildLines(ctx: TenantContext, input: CreateDeliveryInput): Promise<DeliveryLine[]> {
  const products = await Promise.all(input.lines.map((l) => productRepo.findById(ctx.shopId, l.productId)));
  const byId = new Map(products.filter((p) => p !== null).map((p) => [p.id, p]));
  const [cats, units] = await Promise.all([categoryRepo.listByShop(ctx.shopId), unitRepo.listForShop(ctx.shopId)]);
  const catById = new Map(cats.map((c) => [c.id, c]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  return input.lines.map((l) => {
    const p = byId.get(l.productId);
    if (!p) throw ApiError.badRequest(`Product not found: ${l.productId}`, 'PRODUCT_NOT_FOUND');
    const unitPriceMinor = l.unitPrice !== undefined ? toMinor(l.unitPrice) : p.sellingPriceMinor;
    // Per-delivery cost price; falls back to the product's cost when not overridden.
    const costPriceMinor = l.costPrice !== undefined ? toMinor(l.costPrice) : (p.purchaseCostMinor ?? 0);
    return {
      productId: p.id,
      name: p.name,
      sku: p.sku,
      category: catById.get(p.categoryId)?.name ?? '',
      imageUrl: p.images?.[0] ?? null,
      quantity: l.quantity,
      unitId: p.unitId,
      unitSymbol: unitById.get(p.unitId)?.symbol ?? '',
      unitPriceMinor,
      costPriceMinor,
      lineTotalMinor: Math.round(unitPriceMinor * l.quantity),
      stockBefore: null,
      stockAfter: null,
    };
  });
}

function computeTotals(lines: DeliveryLine[], input: CreateDeliveryInput) {
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

  return {
    subtotalMinor,
    costPriceMinor,
    discountMinor,
    deliveryChargeMinor,
    grandTotalMinor,
    paidMinor,
    remainingMinor: grandTotalMinor - paidMinor,
  };
}

/**
 * A recorded delivery is a committed sale: create it and deduct stock, so remaining
 * stock drops immediately (the reports already count it as a sale). Stock is marked
 * deducted here, so a later CONFIRMED transition won't re-deduct and a CANCELLED
 * transition restores it (see changeStatus).
 *
 * Mongo wrapped this in a transaction; insufficient stock now unwinds every
 * movement already applied and removes the delivery, so a failed create leaves no
 * delivery and no stock change — the behaviour the tests assert.
 */
export async function createDelivery(ctx: TenantContext, input: CreateDeliveryInput, userId: string) {
  let customer = null;
  if (input.customerId) {
    customer = await customerRepo.findById(ctx.shopId, input.customerId);
    if (!customer) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  }

  const lines = await buildLines(ctx, input);
  const totals = computeTotals(lines, input);
  const now = new Date().toISOString();

  const payments =
    totals.paidMinor > 0
      ? [{
          id: deliveryRepo.newPaymentId(),
          amountMinor: totals.paidMinor,
          method: 'CASH',
          note: 'Initial payment',
          remainingAfterMinor: totals.remainingMinor,
          receivedBy: userId,
          receivedAt: now,
        }]
      : [];

  const delivery = await deliveryRepo.create({
    shopId: ctx.shopId,
    code: generateCode('DEL'),
    customerId: input.customerId ?? null,
    customerName: customer?.name ?? '',
    customerPhone: customer?.phone ?? '',
    lines,
    payments,
    ...totals,
    paymentType: input.paymentType,
    paymentStatus: derivePaymentStatus(totals.grandTotalMinor, totals.paidMinor),
    // The roster "one-click deliver" flow saves straight as DELIVERED; otherwise PENDING.
    status: input.deliverNow ? DeliveryStatus.DELIVERED : DeliveryStatus.PENDING,
    inventoryDeducted: true,
    confirmedAt: input.deliverNow ? now : null,
    deliveredAt: input.deliverNow ? now : null,
    cancelledAt: null,
    assignedToName: input.assignedToName ?? '',
    address: input.address ?? customer?.address ?? '',
    note: input.note ?? '',
    scheduledFor: input.scheduledFor ? new Date(input.scheduledFor).toISOString() : null,
    createdBy: userId,
  });

  const undos: NonNullable<MovementResult['undo']>[] = [];
  try {
    for (const line of delivery.lines) {
      const result = await recordMovement(ctx, {
        productId: line.productId,
        type: InventoryTxnType.DELIVERY,
        quantity: line.quantity,
        refType: RefType.DELIVERY,
        refId: delivery.id,
        performedBy: userId,
        note: `Delivery ${delivery.code}`,
      });
      if (result.undo) undos.push(result.undo);
      if (!result.skipped && result.balanceAfter !== undefined) {
        line.stockAfter = result.balanceAfter;
        line.stockBefore = result.balanceAfter + line.quantity;
      }
    }
  } catch (err) {
    await undoMovements(ctx, undos);
    await deliveryRepo.hardDelete(delivery).catch(() => undefined);
    throw err;
  }

  return deliveryRepo.update(delivery, { lines: delivery.lines });
}

/**
 * Edit an existing delivery (admin). Rebuilds the lines/totals from the input and
 * reconciles stock: restore the previously-deducted quantities, then deduct the new
 * ones (guarded, so insufficient stock unwinds the whole edit).
 */
export async function updateDelivery(ctx: TenantContext, id: string, input: CreateDeliveryInput, userId: string) {
  const delivery = await deliveryRepo.findScoped(ctx.shopId, id);
  if (!delivery) throw ApiError.notFound('Delivery not found', 'DELIVERY_NOT_FOUND');
  if (delivery.status === DeliveryStatus.CANCELLED) {
    throw ApiError.badRequest('Cannot edit a cancelled delivery', 'DELIVERY_CANCELLED');
  }

  let customer = null;
  if (input.customerId) {
    customer = await customerRepo.findById(ctx.shopId, input.customerId);
    if (!customer) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  }

  const lines = await buildLines(ctx, input);
  const totals = computeTotals(lines, input);
  const now = new Date().toISOString();
  const payments =
    totals.paidMinor > 0
      ? [{
          id: deliveryRepo.newPaymentId(),
          amountMinor: totals.paidMinor,
          method: 'CASH',
          note: 'Payment (edited)',
          remainingAfterMinor: totals.remainingMinor,
          receivedBy: userId,
          receivedAt: now,
        }]
      : [];

  const undos: NonNullable<MovementResult['undo']>[] = [];
  try {
    // Give back the old stock, then take the new — net change applied movement by movement.
    if (delivery.inventoryDeducted) {
      for (const line of delivery.lines) {
        const back = await recordMovement(ctx, {
          productId: line.productId,
          type: InventoryTxnType.RETURN,
          quantity: line.quantity,
          refType: RefType.DELIVERY,
          refId: delivery.id,
          performedBy: userId,
          note: `Edit ${delivery.code}`,
        });
        if (back.undo) undos.push(back.undo);
      }
    }
    for (const line of lines) {
      const result = await recordMovement(ctx, {
        productId: line.productId,
        type: InventoryTxnType.DELIVERY,
        quantity: line.quantity,
        refType: RefType.DELIVERY,
        refId: delivery.id,
        performedBy: userId,
        note: `Delivery ${delivery.code}`,
      });
      if (result.undo) undos.push(result.undo);
      if (!result.skipped && result.balanceAfter !== undefined) {
        line.stockAfter = result.balanceAfter;
        line.stockBefore = result.balanceAfter + line.quantity;
      }
    }
  } catch (err) {
    await undoMovements(ctx, undos);
    throw err;
  }

  const goingLive = input.deliverNow && delivery.status !== DeliveryStatus.DELIVERED;
  return deliveryRepo.update(delivery, {
    customerId: input.customerId ?? null,
    customerName: customer?.name ?? '',
    customerPhone: customer?.phone ?? '',
    lines,
    payments,
    ...totals,
    paymentType: input.paymentType,
    paymentStatus: derivePaymentStatus(totals.grandTotalMinor, totals.paidMinor),
    inventoryDeducted: true,
    ...(goingLive
      ? {
          status: DeliveryStatus.DELIVERED,
          deliveredAt: now,
          confirmedAt: delivery.confirmedAt ?? now,
        }
      : {}),
    ...(input.assignedToName !== undefined ? { assignedToName: input.assignedToName } : {}),
    ...(input.address !== undefined ? { address: input.address } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
}

/**
 * Daily delivery roster: every active customer with today's status — DELIVERED if a
 * (non-cancelled) delivery was made for them today, else PENDING. Rolls over at
 * midnight (shop timezone) since "today" moves, and new customers appear automatically.
 */
export async function deliveryRoster(ctx: TenantContext) {
  const shop = await shopRepo.findById(ctx.shopId);
  const range = dayRange(undefined, shop?.timezone ?? 'Asia/Karachi');
  const customers = (await customerRepo.listByShop(ctx.shopId)).sort((a, b) => a.name.localeCompare(b.name));
  const ids = customers.map((c) => c.id);

  const all = await deliveryRepo.listByShop(ctx.shopId);
  const todays = all
    .filter((d) => d.status !== DeliveryStatus.CANCELLED)
    .filter((d) => {
      const t = new Date(d.createdAt).getTime();
      return t >= range.start.getTime() && t <= range.end.getTime();
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Same total-dues source the Customers page uses, so the numbers reconcile.
  const deliveryDues = await outstandingByCustomers(ctx, ids);

  // Per customer: the latest today's delivery (for Edit) plus the sum of today's deliveries.
  const today = new Map<string, { latestId: string; latestCode: string; totalMinor: number }>();
  for (const d of todays) {
    if (!d.customerId) continue;
    const cur = today.get(d.customerId);
    if (!cur) today.set(d.customerId, { latestId: d.id, latestCode: d.code, totalMinor: d.grandTotalMinor });
    else cur.totalMinor += d.grandTotalMinor; // sorted desc → first is latest
  }

  const rows = customers.map((c) => {
    const t = today.get(c.id);
    // Total owed = ledger balance + all delivery dues (matches the Customers page).
    const outstandingMinor = Math.max(0, c.currentBalanceMinor ?? 0) + (deliveryDues.get(c.id) ?? 0);
    return {
      customerId: c.id,
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

/** Attaches customer name/phone/address, which used to come from a Mongoose populate. */
async function attachCustomers<T extends { customerId: string | null }>(ctx: TenantContext, rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.customerId).filter((v): v is string => !!v))];
  const customers = await Promise.all(ids.map((id) => customerRepo.findById(ctx.shopId, id)));
  const byId = new Map(customers.filter((c) => c !== null).map((c) => [c.id, c]));
  return rows.map((r) => {
    const c = r.customerId ? byId.get(r.customerId) : undefined;
    return {
      ...r,
      customerId: c ? { _id: c.id, name: c.name, phone: c.phone, address: c.address } : r.customerId,
    };
  });
}

export async function listDeliveries(
  ctx: TenantContext,
  query: unknown,
  filters: { status?: string; paymentStatus?: string; customerId?: string; from?: string; to?: string },
) {
  const { page, limit, skip, sort, search } = parsePagination(query, '-createdAt');
  let rows = filters.customerId
    ? await deliveryRepo.listByCustomer(ctx.shopId, filters.customerId)
    : await deliveryRepo.listByShop(ctx.shopId);

  if (filters.status) rows = rows.filter((d) => d.status === filters.status);
  if (filters.paymentStatus) rows = rows.filter((d) => d.paymentStatus === filters.paymentStatus);
  if (filters.from || filters.to) {
    const from = filters.from ? new Date(filters.from).getTime() : -Infinity;
    const to = filters.to ? new Date(filters.to).getTime() : Infinity;
    rows = rows.filter((d) => {
      const t = new Date(d.createdAt).getTime();
      return t >= from && t <= to;
    });
  }

  const { data, total } = paginateInMemory(rows, { skip, limit, sort }, {
    search,
    fields: (d) => [d.code, d.customerName],
  });
  return { data: await attachCustomers(ctx, data), meta: buildPageMeta(page, limit, total) };
}

export async function getDelivery(ctx: TenantContext, id: string) {
  const found = await deliveryRepo.findScoped(ctx.shopId, id);
  if (!found) throw ApiError.notFound('Delivery not found', 'DELIVERY_NOT_FOUND');
  const [delivery] = await attachCustomers(ctx, [found]);
  return delivery!;
}

/**
 * Change delivery status with inventory side effects (§5, §6, §15):
 *  - CONFIRMED: deduct stock once (guarded, never negative), snapshot before/after.
 *  - CANCELLED: restore stock if it was deducted. Never double-deduct/double-restore.
 */
export async function changeStatus(ctx: TenantContext, id: string, next: DeliveryStatus, userId: string) {
  const delivery = await deliveryRepo.findScoped(ctx.shopId, id);
  if (!delivery) throw ApiError.notFound('Delivery not found', 'DELIVERY_NOT_FOUND');

  const current = delivery.status;
  if (current === next) return delivery;
  if (!(DELIVERY_TRANSITIONS[current] ?? []).includes(next)) {
    throw ApiError.badRequest(`Cannot change status from ${current} to ${next}`, 'INVALID_TRANSITION');
  }

  const patch: deliveryRepo.DeliveryPatch = { status: next };
  const lines = delivery.lines.map((l) => ({ ...l }));
  const undos: NonNullable<MovementResult['undo']>[] = [];

  try {
    if (next === DeliveryStatus.CONFIRMED && !delivery.inventoryDeducted) {
      for (const line of lines) {
        const result = await recordMovement(ctx, {
          productId: line.productId,
          type: InventoryTxnType.DELIVERY,
          quantity: line.quantity,
          refType: RefType.DELIVERY,
          refId: delivery.id,
          performedBy: userId,
          note: `Delivery ${delivery.code}`,
        });
        if (result.undo) undos.push(result.undo);
        if (!result.skipped && result.balanceAfter !== undefined) {
          line.stockAfter = result.balanceAfter;
          line.stockBefore = result.balanceAfter + line.quantity;
        }
      }
      patch.inventoryDeducted = true;
      patch.confirmedAt = new Date().toISOString();
      patch.lines = lines;
    }

    if (next === DeliveryStatus.CANCELLED && delivery.inventoryDeducted) {
      for (const line of lines) {
        const back = await recordMovement(ctx, {
          productId: line.productId,
          type: InventoryTxnType.RETURN,
          quantity: line.quantity,
          refType: RefType.DELIVERY,
          refId: delivery.id,
          performedBy: userId,
          note: `Cancelled delivery ${delivery.code}`,
        });
        if (back.undo) undos.push(back.undo);
      }
      patch.inventoryDeducted = false;
      patch.cancelledAt = new Date().toISOString();
    }
  } catch (err) {
    await undoMovements(ctx, undos);
    throw err;
  }

  if (next === DeliveryStatus.DELIVERED) patch.deliveredAt = new Date().toISOString();
  return deliveryRepo.update(delivery, patch);
}

/** Record a payment against a delivery (§3, §7). Atomic; blocks overpayment. */
export async function addPayment(ctx: TenantContext, id: string, input: AddPaymentInput, userId: string) {
  const amountMinor = toMinor(input.amount);
  if (amountMinor <= 0) throw ApiError.badRequest('Payment amount must be positive', 'INVALID_AMOUNT');

  const delivery = await deliveryRepo.findScoped(ctx.shopId, id);
  if (!delivery) throw ApiError.notFound('Delivery not found', 'DELIVERY_NOT_FOUND');
  if (delivery.status === DeliveryStatus.CANCELLED) {
    throw ApiError.badRequest('Cannot pay a cancelled delivery', 'DELIVERY_CANCELLED');
  }
  if (amountMinor > delivery.remainingMinor) {
    throw ApiError.badRequest('Payment exceeds the remaining balance', 'OVERPAYMENT');
  }

  const updated = await deliveryRepo.applyPayment(delivery, {
    id: deliveryRepo.newPaymentId(),
    amountMinor,
    method: input.method ?? 'CASH',
    note: input.note ?? '',
    remainingAfterMinor: delivery.remainingMinor - amountMinor,
    receivedBy: userId,
    receivedAt: new Date().toISOString(),
  });

  // The conditional write failed, so another payment landed between our read and
  // our write. Re-read to report the real reason rather than guessing.
  if (!updated) {
    const fresh = await deliveryRepo.findScoped(ctx.shopId, id);
    if (fresh && fresh.status === DeliveryStatus.CANCELLED) {
      throw ApiError.badRequest('Cannot pay a cancelled delivery', 'DELIVERY_CANCELLED');
    }
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
  const wanted = new Set(customerIds);
  const rows = await deliveryRepo.listByShop(ctx.shopId);
  const out = new Map<string, number>();
  for (const d of rows) {
    if (!d.customerId || !wanted.has(d.customerId) || d.status === DeliveryStatus.CANCELLED) continue;
    out.set(d.customerId, (out.get(d.customerId) ?? 0) + d.remainingMinor);
  }
  return out;
}

/** Customer outstanding across all their (non-cancelled) deliveries (§10). */
export async function customerDeliverySummary(ctx: TenantContext, customerId: string) {
  const all = await deliveryRepo.listByCustomer(ctx.shopId, customerId);
  const live = all.filter((d) => d.status !== DeliveryStatus.CANCELLED);
  return {
    totalPurchasesMinor: live.reduce((s, d) => s + d.grandTotalMinor, 0),
    totalPaidMinor: live.reduce((s, d) => s + d.paidMinor, 0),
    outstandingMinor: live.reduce((s, d) => s + d.remainingMinor, 0),
    deliveryCount: live.length,
    deliveries: [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50),
  };
}

export type { DeliveryRecord };
