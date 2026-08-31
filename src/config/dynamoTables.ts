import { env } from './env.js';

/**
 * Source of truth for every DynamoDB table this app uses: logical name, real
 * table name (prefixed per environment), and the key schema/GSIs it needs.
 * Consumed by repositories (to know which table/index to Query) and by the
 * `scripts/provisionDynamoTables.ts` generator that emits the AWS CLI commands
 * to create them (run from AWS CloudShell — see that script's header).
 */

export type AttrType = 'S' | 'N';

export interface GsiDef {
  name: string;
  pk: { name: string; type: AttrType };
  sk?: { name: string; type: AttrType };
  projection?: 'ALL' | 'KEYS_ONLY';
}

export interface TableDef {
  /** Logical name — used in code as TABLES.Sale etc. */
  logicalName: string;
  pk: { name: string; type: AttrType };
  sk?: { name: string; type: AttrType };
  gsis?: GsiDef[];
  /** Enable native DynamoDB TTL on this attribute (epoch seconds). */
  ttlAttribute?: string;
}

export const TABLE_DEFS: TableDef[] = [
  {
    logicalName: 'Sale',
    pk: { name: 'shopId', type: 'S' },
    sk: { name: 'sk', type: 'S' }, // "soldAt#id"
    gsis: [
      { name: 'byCode', pk: { name: 'shopId', type: 'S' }, sk: { name: 'code', type: 'S' } },
      { name: 'byId', pk: { name: 'id', type: 'S' } },
      { name: 'byCustomer', pk: { name: 'shopCustomerKey', type: 'S' }, sk: { name: 'sk', type: 'S' } },
      { name: 'byType', pk: { name: 'shopTypeKey', type: 'S' }, sk: { name: 'sk', type: 'S' } },
    ],
  },
  {
    logicalName: 'SaleCode',
    pk: { name: 'shopCodeKey', type: 'S' }, // "shopId#code"
    sk: { name: 'sk', type: 'S' }, // literal "GUARD"
  },
  {
    logicalName: 'SaleItem',
    pk: { name: 'saleId', type: 'S' },
    sk: { name: 'id', type: 'S' },
    gsis: [{ name: 'byProduct', pk: { name: 'shopProductKey', type: 'S' }, sk: { name: 'saleId', type: 'S' } }],
  },
  {
    logicalName: 'Customer',
    pk: { name: 'shopId', type: 'S' },
    sk: { name: 'id', type: 'S' },
    gsis: [
      { name: 'byPhone', pk: { name: 'shopPhoneKey', type: 'S' } },
      { name: 'byStatus', pk: { name: 'shopStatusKey', type: 'S' }, sk: { name: 'id', type: 'S' } },
    ],
  },
  {
    logicalName: 'CustomerLedger',
    pk: { name: 'customerId', type: 'S' },
    sk: { name: 'sk', type: 'S' }, // "occurredAt#id"
    gsis: [
      { name: 'byShop', pk: { name: 'shopId', type: 'S' }, sk: { name: 'sk', type: 'S' } },
      { name: 'byRef', pk: { name: 'refKey', type: 'S' } }, // "refType#refId"
    ],
  },
  {
    logicalName: 'InventoryTransaction',
    pk: { name: 'productId', type: 'S' },
    sk: { name: 'sk', type: 'S' }, // "occurredAt#id"
    gsis: [
      { name: 'byShopType', pk: { name: 'shopTypeKey', type: 'S' }, sk: { name: 'sk', type: 'S' } },
      { name: 'byRef', pk: { name: 'refKey', type: 'S' } },
    ],
  },
  {
    logicalName: 'Product',
    pk: { name: 'shopId', type: 'S' },
    sk: { name: 'id', type: 'S' },
    gsis: [
      { name: 'bySlug', pk: { name: 'shopSlugKey', type: 'S' } },
      { name: 'bySku', pk: { name: 'shopSkuKey', type: 'S' } },
      { name: 'byCategory', pk: { name: 'shopCategoryKey', type: 'S' }, sk: { name: 'id', type: 'S' } },
      { name: 'byStatus', pk: { name: 'shopStatusAvailKey', type: 'S' }, sk: { name: 'id', type: 'S' } },
    ],
  },
  {
    logicalName: 'Delivery',
    pk: { name: 'shopId', type: 'S' },
    sk: { name: 'sk', type: 'S' }, // "createdAt#id"
    gsis: [
      { name: 'byStatus', pk: { name: 'shopStatusKey', type: 'S' }, sk: { name: 'sk', type: 'S' } },
      { name: 'byPaymentStatus', pk: { name: 'shopPaymentStatusKey', type: 'S' } },
      { name: 'byCustomer', pk: { name: 'shopCustomerKey', type: 'S' } },
    ],
  },
  {
    logicalName: 'DeliveryCode',
    pk: { name: 'shopCodeKey', type: 'S' },
    sk: { name: 'sk', type: 'S' },
  },
  {
    logicalName: 'Payment',
    pk: { name: 'shopId', type: 'S' },
    sk: { name: 'sk', type: 'S' }, // "receivedAt#id"
    gsis: [{ name: 'byCustomer', pk: { name: 'shopCustomerKey', type: 'S' }, sk: { name: 'sk', type: 'S' } }],
  },
  {
    logicalName: 'Category',
    pk: { name: 'shopId', type: 'S' },
    sk: { name: 'id', type: 'S' },
    gsis: [
      { name: 'bySlug', pk: { name: 'shopSlugKey', type: 'S' } },
      { name: 'byParent', pk: { name: 'shopParentKey', type: 'S' }, sk: { name: 'sortOrderKey', type: 'S' } },
    ],
  },
  {
    logicalName: 'Unit',
    pk: { name: 'shopKey', type: 'S' }, // shopId or literal "PLATFORM"
    sk: { name: 'id', type: 'S' },
    gsis: [{ name: 'bySymbol', pk: { name: 'shopSymbolKey', type: 'S' } }],
  },
  {
    logicalName: 'Conversion',
    pk: { name: 'shopId', type: 'S' },
    sk: { name: 'sk', type: 'S' }, // "createdAt#id"
  },
  {
    logicalName: 'AuditLog',
    pk: { name: 'shopKey', type: 'S' }, // shopId or literal "PLATFORM"
    sk: { name: 'sk', type: 'S' }, // "createdAt#id"
    gsis: [{ name: 'byResource', pk: { name: 'resourceKey', type: 'S' } }],
  },
  {
    logicalName: 'User',
    pk: { name: 'id', type: 'S' },
    sk: { name: 'sk', type: 'S' }, // literal "META"
    gsis: [
      { name: 'byEmail', pk: { name: 'email', type: 'S' } },
      // Staff listing is shop-scoped (§22). Without this, listing a shop's users
      // would need a Scan across every tenant's users — both a cost and an
      // isolation hazard. Only set on shop-scoped users; SUPER_ADMIN/USER rows
      // omit it, so they never appear in a shop's staff list.
      { name: 'byShop', pk: { name: 'shopId', type: 'S' }, sk: { name: 'id', type: 'S' } },
    ],
  },
  {
    logicalName: 'Shop',
    pk: { name: 'id', type: 'S' },
    sk: { name: 'sk', type: 'S' },
    gsis: [
      { name: 'bySlug', pk: { name: 'slug', type: 'S' } },
      { name: 'byStatus', pk: { name: 'statusDeletedKey', type: 'S' } },
    ],
  },
  {
    logicalName: 'ShopOwnerGuard',
    pk: { name: 'ownerId', type: 'S' },
    sk: { name: 'sk', type: 'S' },
  },
  {
    logicalName: 'ShopSettings',
    pk: { name: 'shopId', type: 'S' },
    sk: { name: 'sk', type: 'S' },
  },
  {
    logicalName: 'PasswordReset',
    pk: { name: 'email', type: 'S' },
    sk: { name: 'sk', type: 'S' },
    ttlAttribute: 'ttl',
  },
  {
    logicalName: 'Expense',
    pk: { name: 'shopId', type: 'S' },
    sk: { name: 'sk', type: 'S' }, // "incurredAt#id"
    gsis: [{ name: 'byCategory', pk: { name: 'shopCategoryKey', type: 'S' }, sk: { name: 'sk', type: 'S' } }],
  },
  {
    logicalName: 'DailyShopSummary',
    pk: { name: 'shopId', type: 'S' }, // shopId or literal "PLATFORM"
    sk: { name: 'date', type: 'S' }, // "YYYY-MM-DD"
  },
  // Uniqueness guards that mirror {shopId,slug}/{shopId,sku}/{shopId,symbol}
  // unique compound indexes Mongo enforced at the DB level. Each is a single
  // {PK, SK:'GUARD'} item written with ConditionExpression: attribute_not_exists(PK)
  // inside the same transaction as the entity write.
  { logicalName: 'ProductSlugGuard', pk: { name: 'shopSlugKey', type: 'S' }, sk: { name: 'sk', type: 'S' } },
  { logicalName: 'ProductSkuGuard', pk: { name: 'shopSkuKey', type: 'S' }, sk: { name: 'sk', type: 'S' } },
  { logicalName: 'CategorySlugGuard', pk: { name: 'shopSlugKey', type: 'S' }, sk: { name: 'sk', type: 'S' } },
  { logicalName: 'UnitSymbolGuard', pk: { name: 'shopSymbolKey', type: 'S' }, sk: { name: 'sk', type: 'S' } },
  { logicalName: 'ShopSlugGuard', pk: { name: 'slug', type: 'S' }, sk: { name: 'sk', type: 'S' } },
  { logicalName: 'UserEmailGuard', pk: { name: 'email', type: 'S' }, sk: { name: 'sk', type: 'S' } },
];

/** Real table name for a logical entity, honoring DYNAMO_TABLE_PREFIX for env isolation. */
export function tableName(logicalName: string): string {
  return `${env.DYNAMO_TABLE_PREFIX}${logicalName}`;
}

export const TABLES = Object.fromEntries(
  TABLE_DEFS.map((t) => [t.logicalName, tableName(t.logicalName)]),
) as Record<string, string>;
