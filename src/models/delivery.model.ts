import { Schema, model, type InferSchemaType, type Types, type HydratedDocument } from 'mongoose';

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

/** Per-product line — all price/name/category values are SNAPSHOTS (§14). */
const deliveryLineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    sku: { type: String, default: '' },
    category: { type: String, default: '' },
    imageUrl: { type: String, default: null },
    quantity: { type: Number, required: true },
    unitId: { type: Schema.Types.ObjectId, ref: 'Unit', default: null },
    unitSymbol: { type: String, default: '' },
    unitPriceMinor: { type: Number, required: true },
    lineTotalMinor: { type: Number, required: true },
    // Inventory snapshot captured at confirmation (§4).
    stockBefore: { type: Number, default: null },
    stockAfter: { type: Number, default: null },
  },
  { _id: false },
);

/** Immutable payment history entries (§7). */
const deliveryPaymentSchema = new Schema(
  {
    amountMinor: { type: Number, required: true, min: 1 },
    method: { type: String, default: 'CASH' },
    note: { type: String, default: '' },
    remainingAfterMinor: { type: Number, required: true },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    receivedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const deliverySchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    code: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    // Customer snapshot so historical records stay accurate.
    customerName: { type: String, default: '' },
    customerPhone: { type: String, default: '' },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', default: null },

    lines: { type: [deliveryLineSchema], default: [] },

    // Financials (integer paisa — §11/§14)
    subtotalMinor: { type: Number, required: true, default: 0 },
    discountMinor: { type: Number, default: 0 },
    deliveryChargeMinor: { type: Number, default: 0 },
    grandTotalMinor: { type: Number, required: true, default: 0 },
    paidMinor: { type: Number, default: 0 },
    remainingMinor: { type: Number, default: 0 },
    paymentType: { type: String, enum: Object.values(PaymentType), default: PaymentType.CREDIT },
    paymentStatus: { type: String, enum: Object.values(PaymentStatus), default: PaymentStatus.DUE, index: true },

    payments: { type: [deliveryPaymentSchema], default: [] },

    status: { type: String, enum: Object.values(DeliveryStatus), default: DeliveryStatus.PENDING, index: true },
    // Guards against double deduction / double restore (§5, §15).
    inventoryDeducted: { type: Boolean, default: false },

    assignedToName: { type: String, default: '' },
    address: { type: String, default: '' },
    note: { type: String, default: '' },
    scheduledFor: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

deliverySchema.index({ shopId: 1, status: 1, createdAt: -1 });
deliverySchema.index({ shopId: 1, paymentStatus: 1 });
deliverySchema.index({ shopId: 1, customerId: 1 });
deliverySchema.index({ shopId: 1, code: 1 }, { unique: true });

export type DeliveryDoc = InferSchemaType<typeof deliverySchema> & { _id: Types.ObjectId };
export type DeliveryHydrated = HydratedDocument<InferSchemaType<typeof deliverySchema>>;

export const Delivery = model('Delivery', deliverySchema);

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
