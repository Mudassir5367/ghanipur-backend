import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { env } from './env.js';
import { logger } from './logger.js';
import { TABLES } from './dynamoTables.js';

/**
 * No explicit `credentials` — the SDK v3 default provider chain resolves
 * AWS_ACCESS_KEY_ID/SECRET (local .env) or the EC2 instance role (production)
 * automatically, in that order. DYNAMO_ENDPOINT overrides for dynamodb-local.
 */
export const ddbClient = new DynamoDBClient({
  region: env.AWS_REGION,
  ...(env.DYNAMO_ENDPOINT ? { endpoint: env.DYNAMO_ENDPOINT } : {}),
});

export const ddb = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

/** Fail fast at boot if credentials/region/tables are misconfigured. */
export async function pingDatabase(): Promise<void> {
  const anyTable = Object.values(TABLES)[0];
  await ddbClient.send(new DescribeTableCommand({ TableName: anyTable }));
  logger.info('DynamoDB reachable');
}
