# GHANIPUR — Database Design (MongoDB / Mongoose)

Every shop-owned collection has `shopId` (indexed). Money stored in **integer minor
units** (paisa) to avoid float drift. Quantities stored as decimals with an explicit
`unit`. All docs have `createdAt`/`updatedAt`. Soft delete via `isDeleted/deletedAt/
deletedBy` only where non-financial (§49).

## Collections

### User
`name, email(unique), phone, passwordHash, role, shopId?(for shop staff), permissions[],
isActive, emailVerifiedAt?, lastLoginAt?, refreshTokenHash?`
- Index: `email` unique, `shopId`.
- SUPER_ADMIN has no shopId. SHOP_ADMIN/STAFF have shopId.

### Shop
`name, slug(unique), ownerId, logo, banner, description, phone, whatsapp, email,
address{line, city, area, geo?}, businessHours, socialLinks, timezone, currency,
deliverySettings, status(PENDING|ACTIVE|SUSPENDED|INACTIVE), isDeleted…`
- Index: `slug` unique, `ownerId`, `status`.

### Role / Permission
Roles are enum-backed constants with default permission sets in code
(`constants/permissions.ts`); `User.permissions[]` allows per-user overrides. No
separate collection needed unless custom roles per shop are required later.

### Category
`shopId, name, slug, description, image, icon, parentId?, sortOrder, status,
seoTitle, seoDescription, isDeleted…`
- Index: `{shopId, slug}` unique, `{shopId, parentId, sortOrder}`.

### Unit
`shopId?, name, symbol, kind(VOLUME|WEIGHT|COUNT|CUSTOM), isBase, allowsDecimal`
- Shared defaults (shopId null) + shop-custom units.

### Product
`shopId, categoryId, name, sku, slug, description, images[], unitId, unitValue,
purchaseCostMinor, sellingPriceMinor, taxConfig, minStock, currentStock(cached),
trackInventory, isAvailable, deliveryAvailable, status, isDeleted…`
- Index: `{shopId, slug}` unique, `{shopId, sku}` unique, `{shopId, categoryId}`,
  `{shopId, status, isAvailable}`.
- `currentStock` is a cache of the InventoryTransaction ledger, mutated only via `$inc`.

### InventoryTransaction  (append-only ledger — §9)
`shopId, productId, type(STOCK_IN|SALE|DELIVERY|WASTAGE|RETURN|ADJUSTMENT|TRANSFER|
PRODUCTION), quantity(signed), unitId, refType, refId, balanceAfter?, performedBy,
note, occurredAt`
- Index: `{shopId, productId, occurredAt}`, `{shopId, type, occurredAt}`,
  `{refType, refId}`. Immutable.

### Customer
`shopId, name, phone, altPhone, address, type(dynamic string), notes, status,
creditLimitMinor, openingBalanceMinor, currentBalanceMinor(cached), isDeleted…`
- Index: `{shopId, phone}`, `{shopId, status}`, text index on name/phone.
- `currentBalanceMinor` cache mutated only via `$inc` in transactions.

### Sale
`shopId, code, customerId?(null=walk-in/cash), type(CASH|CREDIT), status(COMPLETED|
CANCELLED), subtotalMinor, taxMinor, totalMinor, paidMinor, dueMinor, soldBy,
soldAt, note, reversalOf?`  (immutable; cancel via reversal)
- Index: `{shopId, soldAt}`, `{shopId, customerId, soldAt}`, `{shopId, type, soldAt}`,
  `{shopId, code}` unique.

### SaleItem
`shopId, saleId, productId, name(snapshot), quantity, unitId, unitPriceMinor,
lineTotalMinor`
- Index: `{shopId, saleId}`, `{shopId, productId, ...}`.

### CustomerLedger  (append-only — §13)
`shopId, customerId, entryType(OPENING|CREDIT_SALE|PAYMENT|ADJUSTMENT|REVERSAL),
debitMinor, creditMinor, balanceAfterMinor, refType, refId, occurredAt, note, createdBy`
- Index: `{shopId, customerId, occurredAt}`. Balance = Σdebit − Σcredit, cached on
  Customer.currentBalanceMinor.

### Payment
`shopId, customerId, amountMinor, method(dynamic: CASH|BANK|EASYPAISA|JAZZCASH|CARD|
OTHER), reference, receivedBy, receivedAt, note, reversalOf?`
- Index: `{shopId, customerId, receivedAt}`, `{shopId, receivedAt}`.

### Delivery
`shopId, customerId?, saleId?, productLines[], status(PENDING|OUT_FOR_DELIVERY|
DELIVERED|CANCELLED), assignedTo, scheduledFor, deliveredAt, address, note`
- Index: `{shopId, status, scheduledFor}`, `{shopId, customerId}`.

### Expense  (§20 — extensible, minimal now)
`shopId, category(dynamic), amountMinor, method, description, isRecurring, incurredAt,
createdBy`
- Index: `{shopId, incurredAt}`, `{shopId, category}`.

### DailyClosing  (§54 — architecture ready)
`shopId, date, openingSnapshot, inflow, sales, wastage, closingSnapshot, cashCollected,
creditGenerated, paymentsReceived, outstanding, closedBy`  — derived from ledgers.

### ShopSettings
`shopId, paymentMethods[], customerTypes[], units[], deliverySettings, locale, theme`

### AuditLog (§38)
`actorId, actorRole, shopId?, action, resource, resourceId, ip?, metadata, createdAt`
- Index: `{shopId, createdAt}`, `{actorId, createdAt}`, `{resource, resourceId}`.

## Money & quantity rules
- All money = integer **paisa** (`*Minor`). Format to rupees at the edge only.
- Quantities are `Number` with `unitId`; never assume litres (§7, §67).
- Balances/stock are **derived from ledgers**; cached fields are convenience only and
  are mutated exclusively by atomic `$inc` inside the same transaction as the ledger
  write, so cache can always be rebuilt from the ledger.
