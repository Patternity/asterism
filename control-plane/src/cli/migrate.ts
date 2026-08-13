/**
 * Migration entry point.
 *
 * `npm run migrate` applies every pending migration; `npm run migrate -- down`
 * rolls the whole schema back, which is a development convenience and not a
 * data-preserving operation.
 */
import { createPool, migrate, rollbackAll } from '../db.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const pool = createPool(databaseUrl, 2);
  try {
    if (process.argv[2] === 'down') {
      await rollbackAll(pool);
      console.log(JSON.stringify({ action: 'rollback', result: 'ok' }));
      return;
    }
    const version = await migrate(pool);
    console.log(JSON.stringify({ action: 'migrate', schema_version: version }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ action: 'migrate', error: String(error) }));
  process.exitCode = 1;
});
