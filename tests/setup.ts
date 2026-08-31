import { afterEach } from 'vitest';

// Env must be set before any app module (which imports config/env) is loaded.
// globalSetup sets these too, but that runs in a different process — workers get
// their own environment, so they must be set here as well.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef';
process.env.LOG_LEVEL = 'silent';
process.env.SUPER_ADMIN_SETUP_KEY = 'test-setup-key-123456';

// globalSetup launches DynamoDB Local (needs Java) and provisions the prefixed
// test tables once for the whole run; workers just point at it. Set
// DYNAMO_ENDPOINT for your own instance, or DYNAMO_TEST_REMOTE=true to run
// against real AWS — the prefix keeps those inside `ghanipur_*` (what the IAM
// policy allows) while never touching the live `ghanipur_<Entity>` tables.
process.env.DYNAMO_TABLE_PREFIX = process.env.DYNAMO_TABLE_PREFIX ?? 'ghanipur_test_';
process.env.AWS_REGION = process.env.AWS_REGION ?? 'ap-south-1';
if (process.env.DYNAMO_TEST_REMOTE !== 'true') {
  process.env.DYNAMO_ENDPOINT =
    process.env.DYNAMO_ENDPOINT ?? `http://127.0.0.1:${process.env.DYNAMO_LOCAL_PORT ?? 8000}`;
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'local';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'local';
}

/**
 * Resets every table between tests, the way the Mongo harness dropped
 * collections. Listed explicitly rather than derived from TABLE_DEFS so that
 * adding a table is a deliberate decision about whether it should be wiped.
 */
const TABLES_TO_PURGE: [logical: string, keys: string[]][] = [
  ['User', ['id', 'sk']],
  ['UserEmailGuard', ['email', 'sk']],
  ['Shop', ['id', 'sk']],
  ['ShopSlugGuard', ['slug', 'sk']],
  ['ShopOwnerGuard', ['ownerId', 'sk']],
  ['ShopSettings', ['shopId', 'sk']],
  ['Unit', ['shopKey', 'id']],
  ['UnitSymbolGuard', ['shopSymbolKey', 'sk']],
  ['Category', ['shopId', 'id']],
  ['CategorySlugGuard', ['shopSlugKey', 'sk']],
  ['Product', ['shopId', 'id']],
  ['ProductSlugGuard', ['shopSlugKey', 'sk']],
  ['ProductSkuGuard', ['shopSkuKey', 'sk']],
  ['Customer', ['shopId', 'id']],
  ['CustomerLedger', ['customerId', 'sk']],
  ['InventoryTransaction', ['productId', 'sk']],
  ['Sale', ['shopId', 'sk']],
  ['SaleCode', ['shopCodeKey', 'sk']],
  ['SaleItem', ['saleId', 'id']],
  ['Payment', ['shopId', 'sk']],
  ['Delivery', ['shopId', 'sk']],
  ['DeliveryCode', ['shopCodeKey', 'sk']],
  ['Conversion', ['shopId', 'sk']],
  ['Expense', ['shopId', 'sk']],
  ['AuditLog', ['shopKey', 'sk']],
  ['PasswordReset', ['email', 'sk']],
];

afterEach(async () => {
  const { purgeTableForTests } = await import('../src/repositories/dynamo/base.js');
  const { TABLES } = await import('../src/config/dynamoTables.js');
  await Promise.all(
    TABLES_TO_PURGE.map(([logical, keys]) => purgeTableForTests(TABLES[logical] as string, keys)),
  );
});
