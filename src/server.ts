import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { pingDatabase as pingDynamo } from './config/dynamo.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

async function bootstrap(): Promise<void> {
  await connectDatabase();
  await pingDynamo();
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 Ghanipur API listening on ${env.API_URL} (port ${env.PORT}, ${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received, shutting down gracefully...`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    // Force-exit if graceful shutdown stalls
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
