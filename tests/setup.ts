import { beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';

// Env must be set before any app module (which imports config/env) is loaded.
// globalSetup sets these too, but that runs in a different process — workers get
// their own environment, so they must be set here as well.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef';
process.env.MONGO_URI = 'mongodb://localhost:27017/placeholder';
process.env.LOG_LEVEL = 'silent';
process.env.SUPER_ADMIN_SETUP_KEY = 'test-setup-key-123456';

// Users live in DynamoDB. globalSetup launches DynamoDB Local (needs Java) and
// provisions the prefixed test tables once for the whole run; workers just point
// at it. Set DYNAMO_ENDPOINT for your own instance, or DYNAMO_TEST_REMOTE=true
// to run against real AWS — the prefix keeps those inside `ghanipur_*` (what the
// IAM policy allows) while never touching the live `ghanipur_<Entity>` tables.
process.env.DYNAMO_TABLE_PREFIX = process.env.DYNAMO_TABLE_PREFIX ?? 'ghanipur_test_';
process.env.AWS_REGION = process.env.AWS_REGION ?? 'ap-south-1';
if (process.env.DYNAMO_TEST_REMOTE !== 'true') {
  process.env.DYNAMO_ENDPOINT =
    process.env.DYNAMO_ENDPOINT ?? `http://127.0.0.1:${process.env.DYNAMO_LOCAL_PORT ?? 8000}`;
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'local';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'local';
}

// Prefer an external Mongo (Docker/CI/Atlas) when provided — must be a replica set
// so multi-doc transactions run. Otherwise fall back to an in-memory replica set
// (requires the VC++ runtime on Windows).
const externalUri = process.env.MONGO_TEST_URI;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let memoryServer: { stop: () => Promise<void> } | undefined;

beforeAll(async () => {
  let uri = externalUri;
  if (!uri) {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    memoryServer = rs;
    uri = rs.getUri();
  }
  await mongoose.connect(uri, { maxPoolSize: 5 });
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  const { purgeTableForTests } = await import('../src/repositories/dynamo/base.js');
  const { TABLES } = await import('../src/config/dynamoTables.js');
  await Promise.all([
    ...Object.values(collections).map((c) => c.deleteMany({})),
    // Only the tables the port has reached so far; extend as modules migrate.
    purgeTableForTests(TABLES.User as string, ['id', 'sk']),
    purgeTableForTests(TABLES.UserEmailGuard as string, ['email', 'sk']),
    purgeTableForTests(TABLES.Shop as string, ['id', 'sk']),
    purgeTableForTests(TABLES.ShopSlugGuard as string, ['slug', 'sk']),
    purgeTableForTests(TABLES.ShopOwnerGuard as string, ['ownerId', 'sk']),
    purgeTableForTests(TABLES.ShopSettings as string, ['shopId', 'sk']),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop();
});
