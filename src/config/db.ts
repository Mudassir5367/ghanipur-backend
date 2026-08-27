import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectDatabase(uri: string = env.MONGO_URI): Promise<typeof mongoose> {
  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20, // connection pooling (§70)
  });
  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

/** True when the deployment supports multi-doc transactions (replica set). */
export function supportsTransactions(): boolean {
  // Standalone mongod has no oplog session support; Atlas / replica sets do.
  const topology = (mongoose.connection as unknown as { client?: { topology?: { description?: { type?: string } } } }).client?.topology;
  const type = topology?.description?.type;
  return type ? type !== 'Single' : true;
}
