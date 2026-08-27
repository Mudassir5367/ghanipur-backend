/** Inventory ledger transaction types (§9). */
export const InventoryTxnType = {
  STOCK_IN: 'STOCK_IN',
  SALE: 'SALE',
  DELIVERY: 'DELIVERY',
  WASTAGE: 'WASTAGE',
  RETURN: 'RETURN',
  ADJUSTMENT: 'ADJUSTMENT',
  TRANSFER: 'TRANSFER',
  PRODUCTION: 'PRODUCTION',
  CONVERSION_OUT: 'CONVERSION_OUT', // source consumed by a conversion (e.g. milk)
  CONVERSION_IN: 'CONVERSION_IN', // product produced by a conversion (e.g. yogurt)
} as const;
export type InventoryTxnType = (typeof InventoryTxnType)[keyof typeof InventoryTxnType];

/** What a ledger entry references (its source document). */
export const RefType = {
  MANUAL: 'MANUAL',
  SALE: 'SALE',
  DELIVERY: 'DELIVERY',
  PRODUCT: 'PRODUCT',
} as const;
export type RefType = (typeof RefType)[keyof typeof RefType];

/** Types that add stock; the rest remove it. ADJUSTMENT carries its own sign. */
export const INFLOW_TYPES: InventoryTxnType[] = [
  InventoryTxnType.STOCK_IN,
  InventoryTxnType.RETURN,
  InventoryTxnType.PRODUCTION,
  InventoryTxnType.CONVERSION_IN,
];
export const OUTFLOW_TYPES: InventoryTxnType[] = [
  InventoryTxnType.SALE,
  InventoryTxnType.DELIVERY,
  InventoryTxnType.WASTAGE,
  InventoryTxnType.CONVERSION_OUT,
];

/**
 * Milk → derived product yield. 100 units of milk produce 96 units of the converted
 * product (Sweet Milk, Yogurt, …). Single source of truth for the whole app.
 */
export const CONVERSION_RATE = 0.96;

/**
 * Convert a transaction type + magnitude into a signed stock delta.
 * ADJUSTMENT accepts an already-signed quantity (can raise or lower stock).
 */
export function signedDelta(type: InventoryTxnType, quantity: number): number {
  if (type === InventoryTxnType.ADJUSTMENT || type === InventoryTxnType.TRANSFER) return quantity;
  if (INFLOW_TYPES.includes(type)) return Math.abs(quantity);
  if (OUTFLOW_TYPES.includes(type)) return -Math.abs(quantity);
  return quantity;
}
