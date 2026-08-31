import { randomBytes } from 'node:crypto';

/**
 * Generates 24-character hex ids in MongoDB ObjectId format.
 *
 * Deliberate transitional choice. While the Mongo -> DynamoDB port is partial,
 * records that still live in Mongo reference migrated entities through
 * `shopId`/`ownerId`/`performedBy` fields typed as ObjectId. Mongoose casts
 * those on every query, and it rejects anything that is not 24 hex characters —
 * so a ULID here would break every unmigrated module the moment a shop id
 * crossed the boundary.
 *
 * Same layout as ObjectId (4-byte seconds + 5-byte random + 3-byte counter), so
 * ids stay roughly time-sortable. Once nothing in Mongo references these tables,
 * this can be swapped for `ulid` without touching call sites.
 */

const PROCESS_RANDOM = randomBytes(5);
let counter = randomBytes(3).readUIntBE(0, 3);

export function newId(): string {
  const buf = Buffer.allocUnsafe(12);
  buf.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
  PROCESS_RANDOM.copy(buf, 4);
  counter = (counter + 1) % 0xffffff;
  buf.writeUIntBE(counter, 9, 3);
  return buf.toString('hex');
}

/** Guards against a malformed id reaching a Query and returning nothing silently. */
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{24}$/.test(id);
}
