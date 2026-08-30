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

/**
 * Boot check for credentials/region/tables. Only FATAL when DYNAMO_REQUIRED=true.
 *
 * No module reads DynamoDB yet (every repository still goes through Mongoose),
 * so a missing table or absent instance role must not crash-loop the container
 * on a deployment that runs perfectly well on Mongo alone. Turn the flag on once
 * the port is complete and the tables actually back live reads.
 */
export async function pingDatabase(): Promise<void> {
  const anyTable = Object.values(TABLES)[0];
  try {
    await ddbClient.send(new DescribeTableCommand({ TableName: anyTable }));
    logger.info('DynamoDB reachable');
  } catch (err) {
    if (env.dynamoRequired) throw err;
    logger.warn(
      { err, table: anyTable },
      'DynamoDB unreachable — continuing, since no module reads it yet. Set DYNAMO_REQUIRED=true to make this fatal.',
    );
  }
}
