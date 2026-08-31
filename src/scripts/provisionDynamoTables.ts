import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  UpdateTableCommand,
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

/**
 * Adds any GSI declared in TABLE_DEFS that the live table is missing, so a new
 * access pattern can ship without dropping the table. DynamoDB permits exactly
 * one index addition per UpdateTable and rejects the next while one is
 * backfilling, so these are applied one at a time and awaited.
 */
async function addMissingGsis(name: string, def: TableDef): Promise<string[]> {
  const declared = def.gsis ?? [];
  if (!declared.length) return [];

  const added: string[] = [];
  for (const gsi of declared) {
    const current = await ddbClient.send(new DescribeTableCommand({ TableName: name }));
    const live = current.Table?.GlobalSecondaryIndexes ?? [];
    if (live.some((g) => g.IndexName === gsi.name)) continue;

    // Only the attributes this index keys on need declaring on the update.
    const attrs: AttributeDefinition[] = [{ AttributeName: gsi.pk.name, AttributeType: gsi.pk.type }];
    if (gsi.sk) attrs.push({ AttributeName: gsi.sk.name, AttributeType: gsi.sk.type });

    await ddbClient.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: attrs,
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: gsi.name,
              KeySchema: keySchema(gsi.pk, gsi.sk),
              Projection: { ProjectionType: gsi.projection ?? 'ALL' },
            },
          },
        ],
      }),
    );
    await waitForIndexActive(name, gsi.name);
    added.push(gsi.name);
  }
  return added;
}

/**
 * No SDK waiter exists for index status, so poll DescribeTable.
 *
 * The generous timeout is deliberate: a GSI is backfilled in the background and
 * even an almost-empty table took ~3.5 minutes in practice, so a tighter bound
 * fails the run while AWS is still working perfectly normally.
 */
async function waitForIndexActive(table: string, index: string, timeoutMs = 900_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await ddbClient.send(new DescribeTableCommand({ TableName: table }));
    const found = res.Table?.GlobalSecondaryIndexes?.find((g) => g.IndexName === index);
    if (found?.IndexStatus === 'ACTIVE') return;
    if (Date.now() > deadline) throw new Error(`GSI ${table}.${index} did not become ACTIVE in time`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
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

/**
 * Idempotently brings every declared table into existence. Exported so the test
 * harness can prepare its own prefixed tables through exactly the same code the
 * deploy uses — a second implementation would be free to drift.
 */
export async function provisionAll(log: (msg: string) => void = () => {}): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;

  for (const def of TABLE_DEFS) {
    const name = tableName(def.logicalName);

    if (await exists(name)) {
      const added = await addMissingGsis(name, def);
      log(
        added.length
          ? `  update  ${name} (added GSI: ${added.join(', ')})`
          : `  skip    ${name} (already exists)`,
      );
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
      log(`  created ${name}`);
      created += 1;
    }

    if (def.ttlAttribute && (await ensureTtl(name, def.ttlAttribute))) {
      log(`          -> TTL enabled on "${def.ttlAttribute}"`);
    }
  }

  return { created, skipped };
}

async function main(): Promise<void> {
  const prefix = process.env.DYNAMO_TABLE_PREFIX ?? '';
  const region = process.env.AWS_REGION ?? 'ap-south-1';
  // eslint-disable-next-line no-console
  const log = (msg: string) => console.log(msg);
  log(
    `Provisioning ${TABLE_DEFS.length} tables in ${region}` +
      `${prefix ? ` with prefix "${prefix}"` : ' (no prefix)'}\n`,
  );
  const { created, skipped } = await provisionAll(log);
  log(`\n${created} created, ${skipped} already present. Run \`npm run check:dynamo\` to verify.`);
}

// Only self-execute when run as a script; importing it (tests) must not provision.
if (process.argv[1]?.includes('provisionDynamoTables')) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Provisioning failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
