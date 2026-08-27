import mongoose, { type ClientSession } from 'mongoose';
import { supportsTransactions } from '../config/db.js';

/**
 * Run `fn` inside a Mongo transaction when the deployment supports it
 * (replica set / Atlas). On a standalone mongod (dev), transactions aren't
 * available, so we run without a session — callers must still be written to be
 * correct either way (atomic $inc, etc.). Financial flows should run against a
 * replica set in production (§36, §48).
 */
export async function withTransaction<T>(fn: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
  if (!supportsTransactions()) {
    return fn(undefined);
  }
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
