/**
 * PostgreSQL access and versioned migrations.
 *
 * Migrations are explicit numbered SQL files applied in order inside a
 * transaction, recorded in `schema_migrations`. There is no schema
 * synchronisation magic: what runs in production is the same file set that ran
 * in development, in the same order.
 *
 * Startup refuses to run against a database whose schema is newer than this
 * build understands, because a newer schema may have moved data this code would
 * then misinterpret.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/** Highest schema version this build supports. */
export const SUPPORTED_SCHEMA_VERSION = 3;

export function createPool(databaseUrl: string, max = 10): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max });
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function ensureMigrationTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function currentSchemaVersion(pool: Pool): Promise<number> {
  await ensureMigrationTable(pool);
  const result = await pool.query<{ version: number }>(
    'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
  );
  return Number(result.rows[0]?.version ?? 0);
}

interface MigrationFile {
  version: number;
  name: string;
  file: string;
}

async function listMigrations(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .map((file) => {
      const match = /^(\d+)_(.+)\.sql$/.exec(file);
      if (!match?.[1] || !match[2]) {
        throw new Error(`migration file ${file} does not follow <version>_<name>.sql`);
      }
      return { version: Number(match[1]), name: match[2], file };
    })
    .sort((a, b) => a.version - b.version);
}

/** Apply every migration newer than the recorded version. */
export async function migrate(pool: Pool): Promise<number> {
  await ensureMigrationTable(pool);
  const applied = await currentSchemaVersion(pool);
  const migrations = await listMigrations();

  for (const migration of migrations) {
    if (migration.version <= applied) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, migration.file), 'utf8');
    // One transaction per migration: a failure leaves the database on the last
    // fully applied version rather than half-way through this one.
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    });
  }

  return currentSchemaVersion(pool);
}

/**
 * Refuse to serve a database newer than this build.
 *
 * Running old code against a new schema is the dangerous direction: the code
 * cannot know what a later migration moved or renamed.
 */
export async function assertSchemaCompatible(pool: Pool): Promise<number> {
  const version = await currentSchemaVersion(pool);
  if (version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${version} is newer than this build supports ` +
        `(${SUPPORTED_SCHEMA_VERSION}); refusing to start`,
    );
  }
  if (version < SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${version} is older than required ` +
        `(${SUPPORTED_SCHEMA_VERSION}); run migrations first`,
    );
  }
  return version;
}

/** Drop every schema object, newest migration first. Development only. */
export async function rollbackAll(pool: Pool): Promise<void> {
  const entries = await readdir(MIGRATIONS_DIR);
  const downs = entries
    .filter((name) => name.endsWith('.down.sql'))
    .sort()
    .reverse();

  // All-or-nothing: a failed older down migration must not leave newer schema
  // objects removed while their version rows still claim they exist.
  await withTransaction(pool, async (client) => {
    for (const file of downs) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
    }
    await client.query('DROP TABLE IF EXISTS schema_migrations');
  });
}
