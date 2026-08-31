/**
 * Runs ONCE for the whole test run, before any worker starts.
 *
 * DynamoDB Local binds a TCP port, so it cannot live in `setupFiles` — that runs
 * per test file and every worker after the first would fail with EADDRINUSE.
 * Table provisioning belongs here for the same reason: once, not per file.
 */
import type { GlobalSetupContext } from 'vitest/node';

const PORT = Number(process.env.DYNAMO_LOCAL_PORT ?? 8000);
const useLocal = !process.env.DYNAMO_ENDPOINT && process.env.DYNAMO_TEST_REMOTE !== 'true';

export async function setup(_ctx: GlobalSetupContext): Promise<void> {
  // Must be set before any module reads config/env.
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef';
  
  process.env.LOG_LEVEL = 'silent';
  process.env.DYNAMO_TABLE_PREFIX = process.env.DYNAMO_TABLE_PREFIX ?? 'ghanipur_test_';
  process.env.AWS_REGION = process.env.AWS_REGION ?? 'ap-south-1';

  if (useLocal) {
    process.env.DYNAMO_ENDPOINT = `http://127.0.0.1:${PORT}`;
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    const { default: DynamoDbLocal } = await import('dynamodb-local');
    await DynamoDbLocal.launch(PORT, null, ['-sharedDb', '-inMemory']);
  }

  // Same provisioning code the deploy runs, so the test schema cannot drift.
  const { provisionAll } = await import('../src/scripts/provisionDynamoTables.js');
  await provisionAll();
}

export async function teardown(): Promise<void> {
  if (useLocal) {
    const { default: DynamoDbLocal } = await import('dynamodb-local');
    await DynamoDbLocal.stop(PORT);
  }
}
