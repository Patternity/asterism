import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { providerCapabilitiesRepo } from '../../src/provider-capabilities-repository.js';
import { SUPPORTED_SCHEMA_VERSION } from '../../src/provider-capabilities.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORG = 'org_bootstrap';
const NODE = 'node-reporting';
const LEGACY = 'node-legacy';

let pool: Pool;

beforeAll(async () => {
  pool = createPool(DATABASE_URL);
  await rollbackAll(pool).catch(() => undefined);
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE node_provider_capabilities, nodes CASCADE');
  for (const nodeId of [NODE, LEGACY]) {
    await pool.query(
      `INSERT INTO nodes (node_id, organization_id, display_name, public_key, fingerprint,
                          identity_generation)
       VALUES ($1, $2, $1, 'k' || $1, 'f' || $1, 1)`,
      [nodeId, ORG],
    );
  }
});

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    runtime_release: 'v0.1.0-alpha.23',
    reported_at: 1_757_000_000,
    providers: [
      {
        id: 'openai-codex',
        display_name: 'OpenAI Codex',
        auth_methods: ['device_authorization'],
        availability: 'available',
      },
    ],
    ...overrides,
  };
}

describe('what a Node reported, written down', () => {
  it('keeps the providers, the release and when the Node observed it', async () => {
    const verdict = await providerCapabilitiesRepo.record(pool, NODE, snapshot());
    expect(verdict.status).toBe('ok');

    const row = await providerCapabilitiesRepo.byNode(pool, NODE);
    expect(row?.status).toBe('ok');
    expect(row?.schema_version).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(row?.runtime_release).toBe('v0.1.0-alpha.23');
    expect(row?.providers).toEqual([
      {
        id: 'openai-codex',
        display_name: 'OpenAI Codex',
        auth_methods: ['device_authorization'],
        availability: 'available',
      },
    ]);
    expect(row?.reported_at?.toISOString()).toBe(new Date(1_757_000_000 * 1000).toISOString());
  });

  /**
   * One row per Node. What matters is what the runtime installed *now*
   * supports; the previous answer describes a runtime that is no longer there.
   */
  it('replaces the previous snapshot rather than accumulating them', async () => {
    await providerCapabilitiesRepo.record(pool, NODE, snapshot());
    await providerCapabilitiesRepo.record(
      pool,
      NODE,
      snapshot({
        runtime_release: 'v0.1.0-alpha.24',
        providers: [
          {
            id: 'openai-codex',
            display_name: 'OpenAI Codex',
            auth_methods: ['device_authorization'],
            availability: 'unavailable',
            unavailable_reason: 'runtime_missing',
          },
        ],
      }),
    );

    const rows = await pool.query('SELECT count(*)::int c FROM node_provider_capabilities');
    expect(rows.rows[0].c).toBe(1);
    const row = await providerCapabilitiesRepo.byNode(pool, NODE);
    expect(row?.runtime_release).toBe('v0.1.0-alpha.24');
    expect(row?.providers?.[0]?.availability).toBe('unavailable');
    expect(row?.providers?.[0]?.unavailable_reason).toBe('runtime_missing');
  });

  /**
   * Kept rather than discarded. A Node speaking a newer contract is a fact an
   * operator needs, and storing nothing would look exactly like a Node that
   * never spoke.
   */
  it('records a schema it cannot read, with no providers behind it', async () => {
    const verdict = await providerCapabilitiesRepo.record(
      pool,
      NODE,
      snapshot({ schema_version: 99 }),
    );
    expect(verdict.status).toBe('unsupported_schema');

    const row = await providerCapabilitiesRepo.byNode(pool, NODE);
    expect(row?.status).toBe('unsupported_schema');
    expect(row?.schema_version).toBe(99);
    expect(row?.providers).toBeNull();
    expect(row?.runtime_release).toBeNull();
  });

  /** A readable snapshot beats a row that says nothing. */
  it('leaves the last good snapshot alone when a later report is unreadable', async () => {
    await providerCapabilitiesRepo.record(pool, NODE, snapshot());
    const verdict = await providerCapabilitiesRepo.record(pool, NODE, { providers: 'nonsense' });
    expect(verdict.status).toBe('malformed');

    const row = await providerCapabilitiesRepo.byNode(pool, NODE);
    expect(row?.status).toBe('ok');
    expect(row?.providers).toHaveLength(1);
  });

  it('writes nothing at all for a first report that is unreadable', async () => {
    await providerCapabilitiesRepo.record(pool, NODE, { schema_version: 'one' });
    expect(await providerCapabilitiesRepo.byNode(pool, NODE)).toBeNull();
  });

  it('lets go of the snapshot when the Node is removed', async () => {
    await providerCapabilitiesRepo.record(pool, NODE, snapshot());
    await pool.query('DELETE FROM nodes WHERE node_id = $1', [NODE]);
    expect(await providerCapabilitiesRepo.byNode(pool, NODE)).toBeNull();
  });

  it('refuses a snapshot for a Node that does not exist', async () => {
    await expect(
      providerCapabilitiesRepo.record(pool, `ghost_${randomUUID()}`, snapshot()),
    ).rejects.toThrow();
  });
});

describe('the three ways of not knowing', () => {
  /**
   * A release older than the contract has said nothing. Presenting that as
   * "supports no providers" would be a confident claim nobody made — and
   * specifically, it must not be read as supporting the one provider that
   * happens to exist today.
   */
  it('a Node that never reported is unknown, not empty and not assumed', async () => {
    const view = await providerCapabilitiesRepo.viewFor(pool, LEGACY, true);
    expect(view).toEqual({ state: 'unknown' });
    expect(JSON.stringify(view)).not.toContain('openai-codex');
  });

  it('an offline Node shows its last snapshot as stale', async () => {
    await providerCapabilitiesRepo.record(pool, NODE, snapshot());

    const online = await providerCapabilitiesRepo.viewFor(pool, NODE, true);
    expect(online.state).toBe('reported');
    if (online.state !== 'reported') throw new Error('unreachable');
    expect(online.stale).toBe(false);

    const offline = await providerCapabilitiesRepo.viewFor(pool, NODE, false);
    if (offline.state !== 'reported') throw new Error('unreachable');
    expect(offline.stale).toBe(true);
    // Still readable, and still exactly what was reported.
    expect(offline.providers?.[0]?.id).toBe('openai-codex');
  });

  it('an unreadable schema is carried through to the view', async () => {
    await providerCapabilitiesRepo.record(pool, NODE, snapshot({ schema_version: 99 }));
    const view = await providerCapabilitiesRepo.viewFor(pool, NODE, true);
    if (view.state !== 'reported') throw new Error('unreachable');
    expect(view.status).toBe('unsupported_schema');
    expect(view.schema_version).toBe(99);
    expect(view.providers).toBeNull();
  });
});
