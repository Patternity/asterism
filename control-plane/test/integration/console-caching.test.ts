/**
 * How long a browser is told to keep the console.
 *
 * This is not a detail. `index.html` is the file that names the hashed asset
 * bundles, and every deployment changes those names and removes the previous
 * ones. A browser holding a cached `index.html` therefore asks for JavaScript
 * that no longer exists, receives a 404, and renders an empty page — while the
 * server is perfectly healthy and every check reports green.
 *
 * It happened in production, and on every deployment before it, because one
 * cache lifetime was applied to the whole directory. The assertions below are
 * the two lifetimes, kept apart.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool, migrate, type Pool } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://127.0.0.1:8080';

let pool: Pool;
let app: FastifyInstance;
let channel: NodeChannel;
let staticRoot: string;

beforeAll(async () => {
  pool = createPool(DATABASE_URL, 4);
  await migrate(pool);

  // A console directory shaped like a real build: one entry point that names a
  // hashed bundle, and the bundle itself.
  staticRoot = await mkdtemp(path.join(tmpdir(), 'asterism-console-'));
  await mkdir(path.join(staticRoot, 'assets'), { recursive: true });
  await writeFile(
    path.join(staticRoot, 'index.html'),
    '<!doctype html><script src="/assets/index-abc123.js"></script>',
  );
  await writeFile(path.join(staticRoot, 'assets/index-abc123.js'), 'console.log(1)');

  const config: Config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    PUBLIC_BASE_URL: ORIGIN,
    ALLOWED_ORIGINS: ORIGIN,
    ALLOW_PLAINTEXT: 'true',
    STATIC_ROOT: staticRoot,
    // A fixture, not a credential: compatibility mode is on by default outside
    // production and refuses to start without one long enough.
    ASTERISM_OPERATOR_TOKEN: 'o'.repeat(48),
  });
  channel = new NodeChannel({ pool, config, log: createLogger('fatal') });
  app = await buildApp({ pool, config, log: createLogger('fatal'), channel });
}, 90_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await rm(staticRoot, { recursive: true, force: true });
});

describe('what a browser is told to keep', () => {
  it('lets the entry point expire so a deployment can take effect', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });
    expect(response.statusCode).toBe(200);
    const cacheControl = response.headers['cache-control'];
    expect(cacheControl).toBe('no-cache');
    // `immutable` is the specific word that stops a browser even asking, which
    // is what turned a stale entry point into a page that could not recover.
    expect(cacheControl).not.toContain('immutable');
  });

  it('says the same about an application route served by the fallback', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/nodes/add',
      headers: { accept: 'text/html' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('still keeps hashed bundles forever, which is the point of hashing them', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('immutable');
    expect(response.headers['cache-control']).toContain('max-age=31536000');
  });

  it('still answers a missing API path with JSON rather than the console', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/nothing-here',
      headers: { accept: 'text/html' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });
});
