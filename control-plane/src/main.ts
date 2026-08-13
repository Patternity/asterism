/**
 * Control Plane entry point.
 *
 * Startup order matters: configuration is validated, then the schema is checked
 * for compatibility, and only then does anything start listening. A service
 * that accepts a Node before it knows its schema is usable is worse than one
 * that refuses to start.
 */
import { loadConfig, describe as describeConfig } from './config.js';
import { assertSchemaCompatible, createPool } from './db.js';
import { createLogger } from './logger.js';
import { NodeChannel } from './node-channel.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  log.info('control plane starting', describeConfig(config));

  const pool = createPool(config.databaseUrl, config.maxConnections);
  const schemaVersion = await assertSchemaCompatible(pool);
  log.info('schema verified', { schema_version: schemaVersion });

  const channel = new NodeChannel(pool, config, log);
  const app = await buildApp({ pool, config, log, channel });
  channel.start();

  await app.listen({ host: config.httpHost, port: config.httpPort });
  log.info('control plane listening', { host: config.httpHost, port: config.httpPort });

  // Graceful shutdown: stop accepting, close Node sessions, drain the pool.
  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    try {
      await app.close();
      await channel.stop();
      await pool.end();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'fatal', message: String(error) }));
  process.exit(1);
});
