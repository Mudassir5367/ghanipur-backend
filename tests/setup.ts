import { beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';

// Env must be set before any app module (which imports config/env) is loaded.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef';
process.env.MONGO_URI = 'mongodb://localhost:27017/placeholder';
process.env.LOG_LEVEL = 'silent';
process.env.SUPER_ADMIN_SETUP_KEY = 'test-setup-key-123456';

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
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop();
});
