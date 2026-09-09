import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { nodeCredentialsRepo } from '../../src/node-credentials-repository.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORG = 'org_bootstrap';
const NODE = 'node-holding';
const OTHER = 'node-other';

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
  await pool.query('TRUNCATE node_provider_credentials, nodes CASCADE');
  for (const nodeId of [NODE, OTHER]) {
    await pool.query(
      `INSERT INTO nodes (node_id, organization_id, display_name, public_key, fingerprint,
                          identity_generation)
       VALUES ($1, $2, $1, 'k' || $1, 'f' || $1, 1)`,
      [nodeId, ORG],
    );
  }
});

function credential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-0011aabb',
    provider_id: 'openai-codex',
    auth_method: 'device_authorization',
    label: 'Existing credential',
    state: 'authorized',
    created_at: 1_757_000_000,
    updated_at: 1_757_000_100,
    ...overrides,
  };
}

describe('what a Node holds, written down', () => {
  it('keeps every safe field and nothing else', async () => {
    const verdict = await nodeCredentialsRepo.replace(pool, NODE, [credential()]);
    expect(verdict.status).toBe('ok');

    const rows = await nodeCredentialsRepo.forNode(pool, NODE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      node_id: NODE,
      credential_id: 'cred-0011aabb',
      provider_id: 'openai-codex',
      auth_method: 'device_authorization',
      label: 'Existing credential',
      state: 'authorized',
    });
    expect(rows[0]?.created_at?.toISOString()).toBe(new Date(1_757_000_000 * 1000).toISOString());
  });

  /** The adopted credential, exactly as node-1 will report it. */
  it('records the adopted credential under its plain label', async () => {
    await nodeCredentialsRepo.replace(pool, NODE, [credential()]);
    const rows = await nodeCredentialsRepo.forNode(pool, NODE);
    expect(rows[0]?.label).toBe('Existing credential');
    expect(rows[0]?.state).toBe('authorized');
  });

  /**
   * A Node's report is the whole truth about that Node, so a credential missing
   * from a later one is gone. Merging would keep a revoked credential visible
   * forever, and the row nobody can explain is the one somebody acts on.
   */
  it('replaces the whole list rather than merging into it', async () => {
    await nodeCredentialsRepo.replace(pool, NODE, [
      credential(),
      credential({ id: 'cred-second', label: 'Second' }),
    ]);
    expect(await nodeCredentialsRepo.forNode(pool, NODE)).toHaveLength(2);

    await nodeCredentialsRepo.replace(pool, NODE, [credential()]);
    const rows = await nodeCredentialsRepo.forNode(pool, NODE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.credential_id).toBe('cred-0011aabb');
  });

  it('repeating the same report changes nothing', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await nodeCredentialsRepo.replace(pool, NODE, [credential()]);
    }
    const rows = await nodeCredentialsRepo.forNode(pool, NODE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Existing credential');
  });

  /** Two credentials for one provider, side by side and independent. */
  it('holds two credentials for the same provider without confusing them', async () => {
    await nodeCredentialsRepo.replace(pool, NODE, [
      credential({ id: 'cred-first', label: 'Existing credential' }),
      credential({ id: 'cred-second', label: 'Second account', state: 'authorizing' }),
    ]);
    const rows = await nodeCredentialsRepo.forNode(pool, NODE);
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((row) => [row.credential_id, row]));
    expect(byId.get('cred-first')?.state).toBe('authorized');
    expect(byId.get('cred-first')?.label).toBe('Existing credential');
    expect(byId.get('cred-second')?.state).toBe('authorizing');
    // Same provider, different credentials.
    expect(byId.get('cred-first')?.provider_id).toBe(byId.get('cred-second')?.provider_id);
  });

  /** One Node's report never touches another's. */
  it('keeps each Node to itself', async () => {
    await nodeCredentialsRepo.replace(pool, NODE, [credential()]);
    await nodeCredentialsRepo.replace(pool, OTHER, []);
    expect(await nodeCredentialsRepo.forNode(pool, NODE)).toHaveLength(1);
    expect(await nodeCredentialsRepo.forNode(pool, OTHER)).toHaveLength(0);
  });

  it('leaves what is recorded alone when a report is unreadable', async () => {
    await nodeCredentialsRepo.replace(pool, NODE, [credential()]);
    const verdict = await nodeCredentialsRepo.replace(pool, NODE, 'nonsense');
    expect(verdict.status).toBe('malformed');
    expect(await nodeCredentialsRepo.forNode(pool, NODE)).toHaveLength(1);
  });

  it('lets go of credentials when the Node is removed', async () => {
    await nodeCredentialsRepo.replace(pool, NODE, [credential()]);
    await pool.query('DELETE FROM nodes WHERE node_id = $1', [NODE]);
    expect(await nodeCredentialsRepo.forNode(pool, NODE)).toHaveLength(0);
  });

  it('answers whether a Node has a credential, scoped to that Node', async () => {
    await nodeCredentialsRepo.replace(pool, NODE, [credential()]);
    expect(await nodeCredentialsRepo.exists(pool, NODE, 'cred-0011aabb')).toBe(true);
    expect(await nodeCredentialsRepo.exists(pool, OTHER, 'cred-0011aabb')).toBe(false);
    expect(await nodeCredentialsRepo.exists(pool, NODE, 'cred-absent')).toBe(false);
  });
});

describe('nothing secret can reach this table', () => {
  /**
   * The columns are the guarantee. There is nowhere for a token, a path or a
   * fingerprint to sit, so a Node that reported one has it dropped by the
   * reader — and this asserts the shape rather than trusting that it did.
   */
  it('has no column a secret could live in', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'node_provider_credentials'`,
    );
    const names = columns.rows.map((row) => row.column_name).sort();
    expect(names).toEqual([
      'auth_method',
      'created_at',
      'credential_id',
      'label',
      'node_id',
      'provider_id',
      'recorded_at',
      'state',
      'updated_at',
    ]);
    for (const forbidden of ['token', 'secret', 'path', 'fingerprint', 'code', 'file']) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
  });

  /** And a Node that reports one anyway gets it dropped on the way in. */
  it('drops a secret a Node tried to report', async () => {
    await nodeCredentialsRepo.replace(pool, NODE, [
      credential({
        access_token: 'sk-live-should-never-persist',
        refresh_token: 'rt-should-never-persist',
        user_code: 'RCB8-M9COT',
        path: '/var/lib/asterism/hermes/auth.json',
      }),
    ]);
    const dumped = JSON.stringify(await nodeCredentialsRepo.forNode(pool, NODE));
    for (const secret of [
      'sk-live-should-never-persist',
      'rt-should-never-persist',
      'RCB8-M9COT',
      '/var/lib/asterism',
      'auth.json',
    ]) {
      expect(dumped).not.toContain(secret);
    }
  });
});
