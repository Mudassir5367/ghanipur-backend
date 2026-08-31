import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../config/dynamo.js';

/**
 * Thin helpers over the DynamoDB document client. Deliberately small: this is a
 * seam for the modules being ported off Mongoose, not an ORM. Anything that
 * needs a specific access pattern belongs in that entity's repository, where the
 * GSI it Queries is obvious.
 */

export type Key = Record<string, string>;
export type Item = Record<string, unknown>;

/**
 * Builds the composite partition keys the schema uses for GSIs — "shopId#slug",
 * "shopId#ACTIVE" and so on. DynamoDB indexes on a single attribute, so a
 * two-part access pattern is encoded into one string at write time.
 */
export const compositeKey = (...parts: (string | number | boolean)[]): string => parts.join('#');

/**
 * Sortable sort-key prefix: an ISO timestamp then the id, so a Query returns
 * rows in chronological order and the id keeps it unique when two land in the
 * same millisecond.
 */
export const timeKey = (at: Date | string, id: string): string =>
  `${typeof at === 'string' ? at : at.toISOString()}#${id}`;

/** Thrown when a uniqueness guard rejects a write, so services can map it to 409. */
export class UniqueConstraintError extends Error {
  constructor(public readonly field: string) {
    super(`${field} already taken`);
    this.name = 'UniqueConstraintError';
  }
}

/**
 * Adds the `_id` alias every API response and the frontend still use.
 *
 * Mongo documents were identified by `_id`; DynamoDB items use `id`. Renaming
 * the field in responses would be a breaking change for every screen, so
 * records handed out carry both — `id` is the real key, `_id` mirrors it. Drop
 * this once the clients are migrated.
 */
export function withLegacyId<T extends { id: string }>(record: T): T & { _id: string };
export function withLegacyId<T extends { id: string }>(record: T | null): (T & { _id: string }) | null;
export function withLegacyId<T extends { id: string }>(record: T | null): (T & { _id: string }) | null {
  return record ? Object.assign(record, { _id: record.id }) : null;
}

export async function getItem<T>(table: string, key: Key): Promise<T | null> {
  const res = await ddb.send(new GetCommand({ TableName: table, Key: key }));
  return (res.Item as T | undefined) ?? null;
}

export async function putItem<T extends object>(table: string, item: T): Promise<void> {
  await ddb.send(new PutCommand({ TableName: table, Item: item }));
}

export async function deleteItem(table: string, key: Key): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: table, Key: key }));
}

/**
 * Sets the given attributes, leaving everything else untouched. Undefined values
 * are dropped rather than written as NULL, matching Mongoose's `updateOne`
 * behaviour for omitted fields.
 */
export async function updateItem(table: string, key: Key, patch: Item): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  entries.forEach(([field, value], i) => {
    names[`#f${i}`] = field;
    values[`:v${i}`] = value;
    sets.push(`#f${i} = :v${i}`);
  });

  await ddb.send(
    new UpdateCommand({
      TableName: table,
      Key: key,
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/** One item from a GSI whose partition key uniquely identifies it (e.g. byEmail). */
export async function queryOneByIndex<T>(
  table: string,
  indexName: string,
  attribute: string,
  value: string,
): Promise<T | null> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: '#k = :v',
      ExpressionAttributeNames: { '#k': attribute },
      ExpressionAttributeValues: { ':v': value },
      Limit: 1,
    }),
  );
  return (res.Items?.[0] as T | undefined) ?? null;
}

export interface PageResult<T> {
  items: T[];
  /** Opaque cursor for the next page, or null at the end. */
  cursor: string | null;
}

/**
 * DynamoDB paginates by cursor, not offset — there is no equivalent of skip/limit
 * and no cheap total count. Callers that still need a page/total shaped response
 * must keep that in the module, not here.
 */
export async function queryPageByIndex<T>(
  table: string,
  indexName: string,
  attribute: string,
  value: string,
  opts: { limit?: number; cursor?: string | null; ascending?: boolean } = {},
): Promise<PageResult<T>> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: '#k = :v',
      ExpressionAttributeNames: { '#k': attribute },
      ExpressionAttributeValues: { ':v': value },
      Limit: opts.limit ?? 20,
      ScanIndexForward: opts.ascending ?? false,
      ExclusiveStartKey: decodeCursor(opts.cursor),
    }),
  );
  return {
    items: (res.Items ?? []) as T[],
    cursor: encodeCursor(res.LastEvaluatedKey),
  };
}

/**
 * Every item under one partition key, following LastEvaluatedKey to the end.
 *
 * The REST contract returns `{page, limit, total, totalPages}`, which DynamoDB
 * cannot produce — it has no offset and no cheap COUNT. Reading a shop's
 * partition and filtering/sorting/slicing in memory preserves that contract
 * exactly, and the read stays inside one tenant because shopId is the partition
 * key. `hardCap` bounds the blast radius: a shop that outgrows it needs a real
 * cursor API rather than a silently truncated page.
 */
export async function queryAllByPartition<T>(
  table: string,
  attribute: string,
  value: string,
  opts: { indexName?: string; hardCap?: number } = {},
): Promise<T[]> {
  const hardCap = opts.hardCap ?? 5_000;
  const all: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table,
        ...(opts.indexName ? { IndexName: opts.indexName } : {}),
        KeyConditionExpression: '#k = :v',
        ExpressionAttributeNames: { '#k': attribute },
        ExpressionAttributeValues: { ':v': value },
        ExclusiveStartKey: startKey,
      }),
    );
    all.push(...((res.Items ?? []) as T[]));
    startKey = res.LastEvaluatedKey;
  } while (startKey && all.length < hardCap);
  return all;
}

/**
 * Atomically adds `delta` to a numeric attribute and returns the resulting
 * value, optionally refusing the write unless a condition holds.
 *
 * This is what replaces Mongo's `findOneAndUpdate({$inc}, {new:true})` for stock
 * and ledger balances. It matters that UpdateItem — unlike TransactWriteItems,
 * which returns nothing — can both apply the change and hand back the new value
 * in one atomic call, so "decrement only if enough remains, and tell me what is
 * left" needs no read-modify-write and no transaction.
 *
 * Returns null when the condition fails, letting callers distinguish "not
 * allowed" from a genuine error.
 */
export async function atomicAdd(
  table: string,
  key: Key,
  attribute: string,
  delta: number,
  opts: { minResult?: number } = {},
): Promise<number | null> {
  const names: Record<string, string> = { '#a': attribute };
  const values: Record<string, unknown> = { ':d': delta };
  let condition: string | undefined;

  if (opts.minResult !== undefined) {
    // Guard against going below the floor. attribute_not_exists covers a first
    // write, where DynamoDB treats a missing number as 0 for ADD.
    values[':floor'] = opts.minResult - delta;
    condition = `attribute_not_exists(#a) OR #a >= :floor`;
  }

  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression: 'ADD #a :d',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ...(condition ? { ConditionExpression: condition } : {}),
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return (res.Attributes?.[attribute] as number | undefined) ?? null;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

export function encodeCursor(key: Record<string, unknown> | undefined): string | null {
  if (!key) return null;
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    // A malformed cursor restarts from the beginning rather than 500ing — the
    // client only ever gets these from us, so a bad one means a stale link.
    return undefined;
  }
}

export interface GuardSpec {
  table: string;
  key: Key;
  /** Name of the guard's partition key, asserted absent to enforce uniqueness. */
  pkName: string;
  /** Reported on conflict, e.g. "email" or "slug". */
  field: string;
}

/**
 * Writes an entity plus its uniqueness guard rows in one transaction.
 *
 * Mongo enforced these with unique indexes; DynamoDB has no such thing, so each
 * uniqueness rule is a dedicated guard table holding one item per taken value,
 * written with `attribute_not_exists` in the same transaction as the entity. If
 * any guard is already claimed the whole write is rejected, so an entity can
 * never exist with a duplicate email or slug.
 */
export async function putWithGuards<T extends object>(
  table: string,
  item: T,
  guards: GuardSpec[],
  /** Extra rows written in the SAME transaction — e.g. a shop's settings row. */
  alsoPut: { table: string; item: object }[] = [],
): Promise<void> {
  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    { Put: { TableName: table, Item: item } },
    ...guards.map((g) => ({
      Put: {
        TableName: g.table,
        Item: g.key,
        ConditionExpression: `attribute_not_exists(#pk)`,
        ExpressionAttributeNames: { '#pk': g.pkName },
      },
    })),
    ...alsoPut.map((p) => ({ Put: { TableName: p.table, Item: p.item } })),
  ];

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    throw mapCancellation(err, guards);
  }
}

/**
 * Turns a TransactionCanceledException into the specific UniqueConstraintError.
 * The cancellation reasons come back positionally, and index 0 is the entity
 * itself, so guard N maps to reason N+1.
 */
function mapCancellation(err: unknown, guards: GuardSpec[]): unknown {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (e.name !== 'TransactionCanceledException') return err;
  const reasons = e.CancellationReasons ?? [];
  for (let i = 0; i < guards.length; i += 1) {
    const guard = guards[i];
    if (guard && reasons[i + 1]?.Code === 'ConditionalCheckFailed') {
      return new UniqueConstraintError(guard.field);
    }
  }
  return err;
}

/** Releases a uniqueness guard, e.g. when an email changes or a shop is deleted. */
export async function releaseGuard(guard: Pick<GuardSpec, 'table' | 'key'>): Promise<void> {
  await deleteItem(guard.table, guard.key);
}

/**
 * Empties a table by scanning its keys and deleting them.
 *
 * TEST FIXTURE ONLY. A Scan reads every item and costs proportionally, so this
 * must never run against production data — it exists so the suite can reset
 * prefixed test tables between cases, the way the Mongo harness drops
 * collections. Guarded on the table name carrying a test prefix.
 */
export async function purgeTableForTests(table: string, keyNames: string[]): Promise<void> {
  if (!/test/i.test(table)) {
    throw new Error(`purgeTableForTests refused: "${table}" is not a test table`);
  }
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: keyNames.map((_, i) => `#k${i}`).join(', '),
        ExpressionAttributeNames: Object.fromEntries(keyNames.map((n, i) => [`#k${i}`, n])),
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) {
      const key = Object.fromEntries(keyNames.map((n) => [n, item[n] as string]));
      await deleteItem(table, key);
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
}
