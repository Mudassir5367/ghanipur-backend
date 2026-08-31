import { TABLES } from '../../config/dynamoTables.js';
import {
  compositeKey,
  deleteItem,
  putWithGuards,
  queryAllByPartition,
  releaseGuard,
  timeKey,
  updateItem,
  withLegacyId,
  type GuardSpec,
} from './base.js';
import { newId } from './id.js';

/**
 * DynamoDB-backed Delivery store, replacing the Mongoose model.
 *
 * Lines and payment history were Mongo subdocuments; DynamoDB stores nested
 * objects natively, so they stay embedded on the item — which is what the
 * §14 snapshot design wants anyway (prices and names are frozen at delivery
 * time, never joined back to the product).
 *
 * Layout: {shopId, "createdAt#id"}. The `{shopId, code}` unique index becomes
 * the DeliveryCode guard, written in the same transaction as the delivery.
 */

export const DeliveryStatus = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

export const PaymentType = { CASH: 'CASH', CREDIT: 'CREDIT' } as const;
export type PaymentType = (typeof PaymentType)[keyof typeof PaymentType];

export const PaymentStatus = { PAID: 'PAID', PARTIALLY_PAID: 'PARTIALLY_PAID', DUE: 'DUE' } as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export interface DeliveryLine {
  productId: string;
  name: string;
  sku: string;
  category: string;
  imageUrl: string | null;
  quantity: number;
  unitId: string | null;
  unitSymbol: string;
  unitPriceMinor: number;
  costPriceMinor: number;
  lineTotalMinor: number;
  stockBefore: number | null;
  stockAfter: number | null;
}

export interface DeliveryPayment {
  id: string;
  amountMinor: number;
  method: string;
  note: string;
  remainingAfterMinor: number;
  receivedBy: string | null;
  receivedAt: string;
}

export interface DeliveryRecord {
  shopId: string;
  sk: string;
  id: string;
  _id?: string;
  code: string;
  shopStatusKey: string;
  shopPaymentStatusKey: string;
  shopCustomerKey: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  lines: DeliveryLine[];
  payments: DeliveryPayment[];
  subtotalMinor: number;
  /** Σ line cost — stored so per-delivery profit is Selling − Cost without a join. */
  costPriceMinor: number;
  deliveryChargeMinor: number;
  discountMinor: number;
  grandTotalMinor: number;
  paidMinor: number;
  remainingMinor: number;
  paymentType: PaymentType;
  paymentStatus: PaymentStatus;
  status: DeliveryStatus;
  inventoryDeducted: boolean;
  confirmedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  assignedToName: string;
  address: string;
  note: string;
  scheduledFor: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const DELIVERIES = TABLES.Delivery as string;
const CODE_GUARD = TABLES.DeliveryCode as string;
const NO_CUSTOMER = 'NONE';

function codeGuard(shopId: string, code: string): GuardSpec {
  return {
    table: CODE_GUARD,
    key: { shopCodeKey: compositeKey(shopId, code), sk: 'GUARD' },
    pkName: 'shopCodeKey',
    field: 'code',
  };
}

const statusKey = (shopId: string, status: DeliveryStatus) => compositeKey(shopId, status);
const payStatusKey = (shopId: string, s: PaymentStatus) => compositeKey(shopId, s);
const customerKey = (shopId: string, customerId: string | null) => compositeKey(shopId, customerId ?? NO_CUSTOMER);

export async function listByShop(shopId: string): Promise<DeliveryRecord[]> {
  const rows = await queryAllByPartition<DeliveryRecord>(DELIVERIES, 'shopId', shopId);
  return rows.map((r) => withLegacyId(r));
}

export async function findScoped(shopId: string, id: string): Promise<DeliveryRecord | null> {
  return (await listByShop(shopId)).find((d) => d.id === id) ?? null;
}

export async function listByCustomer(shopId: string, customerId: string): Promise<DeliveryRecord[]> {
  const rows = await queryAllByPartition<DeliveryRecord>(
    DELIVERIES,
    'shopCustomerKey',
    customerKey(shopId, customerId),
    { indexName: 'byCustomer' },
  );
  return rows.map((r) => withLegacyId(r));
}

export async function listByStatus(shopId: string, status: DeliveryStatus): Promise<DeliveryRecord[]> {
  const rows = await queryAllByPartition<DeliveryRecord>(DELIVERIES, 'shopStatusKey', statusKey(shopId, status), {
    indexName: 'byStatus',
  });
  return rows.map((r) => withLegacyId(r));
}

export type CreateDeliveryInput = Omit<
  DeliveryRecord,
  'sk' | 'id' | '_id' | 'shopStatusKey' | 'shopPaymentStatusKey' | 'shopCustomerKey' | 'createdAt' | 'updatedAt'
>;

/** Throws UniqueConstraintError('code') if the delivery number is taken. */
export async function create(input: CreateDeliveryInput): Promise<DeliveryRecord> {
  const id = newId();
  const now = new Date().toISOString();
  const record: DeliveryRecord = {
    ...input,
    id,
    sk: timeKey(now, id),
    shopStatusKey: statusKey(input.shopId, input.status),
    shopPaymentStatusKey: payStatusKey(input.shopId, input.paymentStatus),
    shopCustomerKey: customerKey(input.shopId, input.customerId),
    createdAt: now,
    updatedAt: now,
  };
  await putWithGuards(DELIVERIES, record, [codeGuard(input.shopId, input.code)]);
  return withLegacyId(record);
}

export type DeliveryPatch = Partial<
  Omit<DeliveryRecord, 'shopId' | 'sk' | 'id' | '_id' | 'code' | 'createdAt'>
>;

export async function update(delivery: DeliveryRecord, patch: DeliveryPatch): Promise<DeliveryRecord> {
  const next: Record<string, unknown> = { ...patch, updatedAt: new Date().toISOString() };
  // Derived index keys must follow their sources or the GSIs go stale.
  if (patch.status !== undefined) next.shopStatusKey = statusKey(delivery.shopId, patch.status);
  if (patch.paymentStatus !== undefined) next.shopPaymentStatusKey = payStatusKey(delivery.shopId, patch.paymentStatus);
  if (patch.customerId !== undefined) next.shopCustomerKey = customerKey(delivery.shopId, patch.customerId);
  await updateItem(DELIVERIES, { shopId: delivery.shopId, sk: delivery.sk }, next);
  return withLegacyId({ ...delivery, ...next } as DeliveryRecord);
}

/** Hard delete — compensation and test teardown only. */
export async function hardDelete(delivery: Pick<DeliveryRecord, 'shopId' | 'sk' | 'code'>): Promise<void> {
  await deleteItem(DELIVERIES, { shopId: delivery.shopId, sk: delivery.sk });
  await releaseGuard(codeGuard(delivery.shopId, delivery.code));
}

export function newPaymentId(): string {
  return newId();
}

/** Allowed status transitions (§6). Inventory is deducted on CONFIRMED, restored on CANCELLED. */
export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  PENDING: [DeliveryStatus.CONFIRMED, DeliveryStatus.CANCELLED],
  CONFIRMED: [DeliveryStatus.OUT_FOR_DELIVERY, DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED],
  OUT_FOR_DELIVERY: [DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED],
  DELIVERED: [DeliveryStatus.CANCELLED],
  CANCELLED: [],
};

/** Derive payment status from paid vs grand total (§2, §15). */
export function derivePaymentStatus(grandTotalMinor: number, paidMinor: number): PaymentStatus {
  if (paidMinor >= grandTotalMinor) return PaymentStatus.PAID;
  if (paidMinor <= 0) return PaymentStatus.DUE;
  return PaymentStatus.PARTIALLY_PAID;
}

/**
 * Appends a payment and recomputes paid/remaining/status in ONE conditional write.
 *
 * Mongo blocked overpayment race-free with a `remainingMinor >= amount` filter on
 * an atomic pipeline update. The equivalent here is optimistic concurrency: the
 * write asserts `remainingMinor` still equals what we read, so a payment that
 * raced in first makes this one fail rather than silently overpay. Returns null
 * when the condition fails, letting the caller tell the two cases apart.
 */
export async function applyPayment(
  delivery: DeliveryRecord,
  payment: DeliveryPayment,
): Promise<DeliveryRecord | null> {
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const { ddb } = await import('../../config/dynamo.js');

  const paidMinor = delivery.paidMinor + payment.amountMinor;
  const remainingMinor = delivery.grandTotalMinor - paidMinor;
  const paymentStatus = derivePaymentStatus(delivery.grandTotalMinor, paidMinor);

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: DELIVERIES,
        Key: { shopId: delivery.shopId, sk: delivery.sk },
        UpdateExpression:
          'SET paidMinor = :paid, remainingMinor = :remaining, paymentStatus = :ps, ' +
          'shopPaymentStatusKey = :psk, payments = list_append(payments, :p), updatedAt = :now',
        ConditionExpression: 'remainingMinor = :expected AND #st <> :cancelled',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':paid': paidMinor,
          ':remaining': remainingMinor,
          ':ps': paymentStatus,
          ':psk': payStatusKey(delivery.shopId, paymentStatus),
          ':p': [payment],
          ':now': new Date().toISOString(),
          ':expected': delivery.remainingMinor,
          ':cancelled': DeliveryStatus.CANCELLED,
        },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw err;
  }

  return withLegacyId({
    ...delivery,
    paidMinor,
    remainingMinor,
    paymentStatus,
    payments: [...delivery.payments, payment],
  });
}
