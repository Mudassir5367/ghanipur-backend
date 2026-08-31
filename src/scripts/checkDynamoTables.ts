import {
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DescribeContinuousBackupsCommand,
  type GlobalSecondaryIndexDescription,
  type KeySchemaElement,
} from '@aws-sdk/client-dynamodb';
import { ddbClient } from '../config/dynamo.js';
import { TABLE_DEFS, tableName, type TableDef } from '../config/dynamoTables.js';

/**
 * Verifies EVERY DynamoDB table the app declares, not just that credentials
 * work. `pingDatabase()` at boot describes a single table, which says nothing
 * about the other 26 — a half-provisioned account passes it and then fails at
 * runtime on the first Query against a missing index.
 *
 * For each table in TABLE_DEFS this checks that it exists and is ACTIVE, that
 * the key schema matches what the code will Query with, that every declared GSI
 * exists and is ACTIVE, and that TTL is enabled where the definition asks for
 * it. Exits non-zero if anything is wrong, so it can gate a deploy.
 *
 * Run:  npm run check:dynamo
 */

interface Problem {
  table: string;
  issue: string;
}

/** "shopId (HASH) + sk (RANGE)" — for readable mismatch reporting. */
function describeKeys(schema: KeySchemaElement[] | undefined): string {
  if (!schema?.length) return '(none)';
  const hash = schema.find((k) => k.KeyType === 'HASH')?.AttributeName ?? '?';
  const range = schema.find((k) => k.KeyType === 'RANGE')?.AttributeName;
  return range ? `${hash} (HASH) + ${range} (RANGE)` : `${hash} (HASH)`;
}

function expectedKeys(def: TableDef): string {
  return def.sk ? `${def.pk.name} (HASH) + ${def.sk.name} (RANGE)` : `${def.pk.name} (HASH)`;
}

/**
 * Point-in-time recovery is the only thing standing between a bad write and
 * permanent data loss, since DynamoDB is the sole datastore. A table without it
 * is a real finding, not a warning — so it counts as a problem and fails the run.
 *
 * Skipped against DynamoDB Local, which has no such API.
 */
async function checkPitr(name: string, problems: Problem[]): Promise<boolean> {
  if (process.env.DYNAMO_ENDPOINT) return true;
  try {
    const res = await ddbClient.send(new DescribeContinuousBackupsCommand({ TableName: name }));
    const status = res.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus;
    if (status !== 'ENABLED') {
      problems.push({ table: name, issue: `point-in-time recovery is ${status ?? 'DISABLED'} — no recovery from a bad write` });
      return false;
    }
    return true;
  } catch (err) {
    problems.push({ table: name, issue: `could not read backup status: ${(err as { name?: string }).name}` });
    return false;
  }
}

async function checkTtl(name: string, attr: string, problems: Problem[]): Promise<void> {
  const res = await ddbClient.send(new DescribeTimeToLiveCommand({ TableName: name }));
  const spec = res.TimeToLiveDescription;
  if (spec?.TimeToLiveStatus !== 'ENABLED') {
    problems.push({ table: name, issue: `TTL not enabled (expected on "${attr}", status ${spec?.TimeToLiveStatus ?? 'UNKNOWN'})` });
  } else if (spec.AttributeName !== attr) {
    problems.push({ table: name, issue: `TTL on "${spec.AttributeName}", code expects "${attr}"` });
  }
}

function checkGsis(
  name: string,
  def: TableDef,
  actual: GlobalSecondaryIndexDescription[] | undefined,
  problems: Problem[],
): number {
  const expected = def.gsis ?? [];
  const present = actual ?? [];
  for (const want of expected) {
    const found = present.find((g) => g.IndexName === want.name);
    if (!found) {
      problems.push({ table: name, issue: `missing GSI "${want.name}" — Queries using it will fail` });
      continue;
    }
    if (found.IndexStatus !== 'ACTIVE') {
      problems.push({ table: name, issue: `GSI "${want.name}" is ${found.IndexStatus}, not ACTIVE` });
      continue;
    }
    const wantKeys = want.sk ? `${want.pk.name} (HASH) + ${want.sk.name} (RANGE)` : `${want.pk.name} (HASH)`;
    const gotKeys = describeKeys(found.KeySchema);
    if (wantKeys !== gotKeys) {
      problems.push({ table: name, issue: `GSI "${want.name}" keyed on ${gotKeys}, code expects ${wantKeys}` });
    }
  }
  return expected.length;
}

async function main(): Promise<void> {
  const problems: Problem[] = [];
  let ok = 0;

  // eslint-disable-next-line no-console
  console.log(`Checking ${TABLE_DEFS.length} tables in ${process.env.AWS_REGION ?? 'ap-south-1'}...\n`);

  for (const def of TABLE_DEFS) {
    const name = tableName(def.logicalName);
    try {
      const res = await ddbClient.send(new DescribeTableCommand({ TableName: name }));
      const table = res.Table;
      if (!table) {
        problems.push({ table: name, issue: 'DescribeTable returned no table' });
        continue;
      }

      if (table.TableStatus !== 'ACTIVE') {
        problems.push({ table: name, issue: `status is ${table.TableStatus}, not ACTIVE` });
      }

      const gotKeys = describeKeys(table.KeySchema);
      const wantKeys = expectedKeys(def);
      if (gotKeys !== wantKeys) {
        problems.push({ table: name, issue: `keyed on ${gotKeys}, code expects ${wantKeys}` });
      }

      const gsiCount = checkGsis(name, def, table.GlobalSecondaryIndexes, problems);
      if (def.ttlAttribute) await checkTtl(name, def.ttlAttribute, problems);
      const pitr = await checkPitr(name, problems);

      const items = table.ItemCount ?? 0;
      // eslint-disable-next-line no-console
      console.log(`  ok  ${name.padEnd(24)} ${String(gsiCount).padStart(2)} GSI  ${items} items  ${pitr ? "PITR on" : "PITR OFF"}`);
      ok += 1;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const reason = e.name === 'ResourceNotFoundException' ? 'does not exist' : (e.message ?? String(err));
      problems.push({ table: name, issue: reason });
      // eslint-disable-next-line no-console
      console.log(`  ERR ${name.padEnd(24)} ${reason}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n${ok}/${TABLE_DEFS.length} tables reachable`);

  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) {
      // eslint-disable-next-line no-console
      console.error(`  - ${p.table}: ${p.issue}`);
    }
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('All tables present, ACTIVE, and correctly keyed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Check failed before it could finish:', err instanceof Error ? err.message : err);
  process.exit(1);
});
