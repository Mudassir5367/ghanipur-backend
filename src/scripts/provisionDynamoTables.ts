import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type KeySchemaElement,
} from '@aws-sdk/client-dynamodb';
import { ddbClient } from '../config/dynamo.js';
import { TABLE_DEFS, tableName, type TableDef } from '../config/dynamoTables.js';

/**
 * Creates every DynamoDB table declared in TABLE_DEFS, from inside the app
 * itself — so it runs on EC2 against the instance role, with no AWS CLI to
 * install and no hand-maintained copy of the schema to drift.
 *
 * Deliberately NON-DESTRUCTIVE, unlike the generated provision-dynamodb.sh,
 * which deletes tables before recreating them. This one describes first and
 * skips anything that already exists, so re-running it is safe against a
 * populated account. To change an existing table's keys you must drop it
 * yourself — that is a data-losing operation and should be a deliberate act.
 *
 * Run:  npm run provision:dynamo:apply
 */

function attributeDefinitions(def: TableDef): AttributeDefinition[] {
  const attrs = new Map<string, 'S' | 'N'>();
  attrs.set(def.pk.name, def.pk.type);
  if (def.sk) attrs.set(def.sk.name, def.sk.type);
  for (const gsi of def.gsis ?? []) {
    attrs.set(gsi.pk.name, gsi.pk.type);
    if (gsi.sk) attrs.set(gsi.sk.name, gsi.sk.type);
  }
  return [...attrs].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType }));
}

function keySchema(pk: { name: string }, sk?: { name: string }): KeySchemaElement[] {
  const schema: KeySchemaElement[] = [{ AttributeName: pk.name, KeyType: 'HASH' }];
  if (sk) schema.push({ AttributeName: sk.name, KeyType: 'RANGE' });
  return schema;
}

function globalSecondaryIndexes(def: TableDef): GlobalSecondaryIndex[] | undefined {
  if (!def.gsis?.length) return undefined;
  return def.gsis.map((gsi) => ({
    IndexName: gsi.name,
    KeySchema: keySchema(gsi.pk, gsi.sk),
    Projection: { ProjectionType: gsi.projection ?? 'ALL' },
  }));
}

async function exists(name: string): Promise<boolean> {
  try {
    await ddbClient.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

/** TTL is a separate API call — it cannot be set as part of CreateTable. */
async function ensureTtl(name: string, attribute: string): Promise<boolean> {
  const current = await ddbClient.send(new DescribeTimeToLiveCommand({ TableName: name }));
  if (current.TimeToLiveDescription?.TimeToLiveStatus === 'ENABLED') return false;
  await ddbClient.send(
    new UpdateTimeToLiveCommand({
      TableName: name,
      TimeToLiveSpecification: { Enabled: true, AttributeName: attribute },
    }),
  );
  return true;
}

async function main(): Promise<void> {
  const prefix = process.env.DYNAMO_TABLE_PREFIX ?? '';
  const region = process.env.AWS_REGION ?? 'ap-south-1';
  // eslint-disable-next-line no-console
  console.log(
    `Provisioning ${TABLE_DEFS.length} tables in ${region}` +
      `${prefix ? ` with prefix "${prefix}"` : ' (no prefix)'}\n`,
  );

  let created = 0;
  let skipped = 0;

  for (const def of TABLE_DEFS) {
    const name = tableName(def.logicalName);

    if (await exists(name)) {
      // eslint-disable-next-line no-console
      console.log(`  skip    ${name} (already exists)`);
      skipped += 1;
    } else {
      await ddbClient.send(
        new CreateTableCommand({
          TableName: name,
          AttributeDefinitions: attributeDefinitions(def),
          KeySchema: keySchema(def.pk, def.sk),
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: globalSecondaryIndexes(def),
        }),
      );
      // GSIs finish backfilling after the table reports ACTIVE; check:dynamo
      // verifies their status separately.
      await waitUntilTableExists({ client: ddbClient, maxWaitTime: 300 }, { TableName: name });
      // eslint-disable-next-line no-console
      console.log(`  created ${name}`);
      created += 1;
    }

    if (def.ttlAttribute && (await ensureTtl(name, def.ttlAttribute))) {
      // eslint-disable-next-line no-console
      console.log(`          -> TTL enabled on "${def.ttlAttribute}"`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n${created} created, ${skipped} already present. Run \`npm run check:dynamo\` to verify.`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Provisioning failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
