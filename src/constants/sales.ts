export const SaleType = { CASH: 'CASH', CREDIT: 'CREDIT' } as const;
export type SaleType = (typeof SaleType)[keyof typeof SaleType];

export const SaleStatus = { COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED' } as const;
export type SaleStatus = (typeof SaleStatus)[keyof typeof SaleStatus];

/** Customer ledger entry types (§13). Debit = customer owes more; Credit = owes less. */
export const LedgerEntryType = {
  OPENING: 'OPENING',
  CREDIT_SALE: 'CREDIT_SALE',
  PAYMENT: 'PAYMENT',
  ADJUSTMENT: 'ADJUSTMENT',
  REVERSAL: 'REVERSAL',
} as const;
export type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];

export const LedgerRefType = {
  SALE: 'SALE',
  PAYMENT: 'PAYMENT',
  MANUAL: 'MANUAL',
} as const;
export type LedgerRefType = (typeof LedgerRefType)[keyof typeof LedgerRefType];
