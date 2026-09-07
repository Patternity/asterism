import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { grantsFor, readableNodeIds, type AccessRole } from '../../src/access.js';
import { createPool, migrate, resolveMigrationsDir, rollbackAll, type Pool } from '../../src/db.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORG = 'org_bootstrap';

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
  await pool.query('TRUNCATE permissions, memberships, nodes, users CASCADE');
});

async function addUser(role: string | null): Promise<string> {
  const id = `usr_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await pool.query(
    `INSERT INTO users (user_id, normalized_email, password_hash, display_name)
     VALUES ($1, $2, 'x', 'T')`,
    [id, `${id}@example.com`],
  );
  if (role) {
    await pool.query(
      `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)`,
      [ORG, id, role],
    );
  }
  return id;
}

async function addNode(nodeId: string, ownerUserId: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO nodes (node_id, organization_id, display_name, public_key,
                        fingerprint, identity_generation, owner_user_id)
     VALUES ($1, $2, $1, 'k' || $1, 'f' || $1, 1, $3)`,
    [nodeId, ORG, ownerUserId],
  );
}

async function grant(userId: string, scopeType: string, scopeId: string, role: AccessRole) {
  await pool.query(
    `INSERT INTO permissions (permission_id, organization_id, user_id, scope_type, scope_id, role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [`perm_${randomUUID().replace(/-/g, '')}`, ORG, userId, scopeType, scopeId, role],
  );
}

describe('the permissions table protects its own shape', () => {
  it('refuses a scope it does not know', async () => {
    const user = await addUser('developer');
    await expect(grant(user, 'project', 'prj_1', 'read')).rejects.toThrow();
  });

  it('refuses a role it does not know', async () => {
    const user = await addUser('developer');
    await expect(grant(user, 'node', 'node-a', 'owner' as AccessRole)).rejects.toThrow();
  });

  /**
   * Two grants on one scope would make "the strongest applicable" depend on
   * which row was read first. A second grant is an edit, not an addition.
   */
  it('refuses a second grant on the same resource', async () => {
    const user = await addUser('developer');
    await addNode('node-a', null);
    await grant(user, 'node', 'node-a', 'read');
    await expect(grant(user, 'node', 'node-a', 'admin')).rejects.toThrow();
  });

  it('lets go of a grant when the person is removed', async () => {
    const user = await addUser('developer');
    await addNode('node-a', null);
    await grant(user, 'node', 'node-a', 'write');
    await pool.query('DELETE FROM users WHERE user_id = $1', [user]);
    const left = await pool.query('SELECT 1 FROM permissions WHERE user_id = $1', [user]);
    expect(left.rowCount).toBe(0);
  });

  /**
   * A Node whose owner leaves becomes ownerless rather than disappearing: the
   * machine is still enrolled, and deleting it because a person left would be
   * a far larger act than the one that was asked for.
   */
  it('leaves a Node standing when its owner is removed', async () => {
    const user = await addUser('developer');
    await addNode('node-a', user);
    await pool.query('DELETE FROM users WHERE user_id = $1', [user]);
    const node = await pool.query<{ owner_user_id: string | null }>(
      'SELECT owner_user_id FROM nodes WHERE node_id = $1',
      ['node-a'],
    );
    expect(node.rowCount).toBe(1);
    expect(node.rows[0]?.owner_user_id).toBeNull();
  });
});

describe('the migration hands existing members what they already had', () => {
  /**
   * Read from the migration file itself rather than restated here: a backfill
   * that a test describes in its own words is a test of the words.
   */
  function backfillStatement(): string {
    const file = path.join(resolveMigrationsDir(process.cwd()), '009_permission_tree.sql');
    const sql = readFileSync(file, 'utf8');
    const start = sql.indexOf('INSERT INTO permissions');
    expect(start).toBeGreaterThan(0);
    return sql.slice(start);
  }

  it('maps every role to the grant that preserves its access, and skips disabled members', async () => {
    for (const [id, role] of [
      ['u_own', 'owner'],
      ['u_adm', 'admin'],
      ['u_dev', 'developer'],
      ['u_view', 'viewer'],
    ] as const) {
      await pool.query(
        `INSERT INTO users (user_id, normalized_email, password_hash, display_name)
         VALUES ($1, $1 || '@example.com', 'x', 'T')`,
        [id],
      );
      await pool.query(
        `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)`,
        [ORG, id, role],
      );
    }
    // Somebody whose membership was disabled must not be handed anything.
    await pool.query(
      `INSERT INTO users (user_id, normalized_email, password_hash, display_name)
       VALUES ('u_off', 'off@example.com', 'x', 'T')`,
    );
    await pool.query(
      `INSERT INTO memberships (organization_id, user_id, role, disabled_at)
       VALUES ($1, 'u_off', 'admin', now())`,
      [ORG],
    );

    await pool.query('DELETE FROM permissions');
    await pool.query(backfillStatement());

    const rows = await pool.query<{ user_id: string; scope_type: string; role: string }>(
      `SELECT user_id, scope_type, role FROM permissions ORDER BY user_id`,
    );
    expect(rows.rows).toEqual([
      { user_id: 'u_adm', scope_type: 'organization', role: 'admin' },
      { user_id: 'u_dev', scope_type: 'organization', role: 'write' },
      { user_id: 'u_own', scope_type: 'organization', role: 'admin' },
      { user_id: 'u_view', scope_type: 'organization', role: 'read' },
    ]);
  });

  it('can be run twice without doubling anybody up', async () => {
    await pool.query(
      `INSERT INTO users (user_id, normalized_email, password_hash, display_name)
       VALUES ('u_twice', 'twice@example.com', 'x', 'T')`,
    );
    await pool.query(
      `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, 'u_twice', 'developer')`,
      [ORG],
    );
    await pool.query('DELETE FROM permissions');
    await pool.query(backfillStatement());
    await pool.query(backfillStatement());
    const rows = await pool.query(`SELECT 1 FROM permissions WHERE user_id = 'u_twice'`);
    expect(rows.rowCount).toBe(1);
  });
});

describe('which Nodes a person may reach', () => {
  it('an organization owner reaches all of them without a listing', async () => {
    const owner = await addUser('owner');
    await addNode('node-a', null);
    await addNode('node-b', null);
    expect(await readableNodeIds(pool, ORG, owner, 'admin')).toEqual({ all: true, ids: [] });
  });

  it('an organization grant strong enough reaches all of them', async () => {
    const user = await addUser('developer');
    await addNode('node-a', null);
    await grant(user, 'organization', ORG, 'write');
    expect(await readableNodeIds(pool, ORG, user, 'write')).toEqual({ all: true, ids: [] });
    expect(await readableNodeIds(pool, ORG, user, 'read')).toEqual({ all: true, ids: [] });
  });

  /**
   * The case the whole tree exists for: two people, two machines, neither
   * reaching the other's.
   */
  it('a Node owner reaches their own and no one else', async () => {
    const alice = await addUser('developer');
    const bob = await addUser('developer');
    await addNode('node-alice', alice);
    await addNode('node-bob', bob);

    expect(await readableNodeIds(pool, ORG, alice, 'admin')).toEqual({
      all: false,
      ids: ['node-alice'],
    });
    expect(await readableNodeIds(pool, ORG, bob, 'admin')).toEqual({
      all: false,
      ids: ['node-bob'],
    });
  });

  it('a Node grant reaches that Node only, and only at its strength', async () => {
    const user = await addUser('developer');
    await addNode('node-a', null);
    await addNode('node-b', null);
    await grant(user, 'node', 'node-a', 'read');

    expect(await readableNodeIds(pool, ORG, user, 'read')).toEqual({
      all: false,
      ids: ['node-a'],
    });
    // `read` does not reach `write`.
    expect(await readableNodeIds(pool, ORG, user, 'write')).toEqual({ all: false, ids: [] });
  });

  it('an organization grant too weak falls back to what is granted per Node', async () => {
    const user = await addUser('developer');
    await addNode('node-a', null);
    await addNode('node-b', null);
    await grant(user, 'organization', ORG, 'read');
    await grant(user, 'node', 'node-b', 'admin');

    expect(await readableNodeIds(pool, ORG, user, 'read')).toEqual({ all: true, ids: [] });
    expect(await readableNodeIds(pool, ORG, user, 'admin')).toEqual({
      all: false,
      ids: ['node-b'],
    });
  });

  it('somebody with nothing reaches nothing', async () => {
    const user = await addUser('developer');
    await addNode('node-a', null);
    expect(await readableNodeIds(pool, ORG, user, 'read')).toEqual({ all: false, ids: [] });
  });

  it('reads back exactly the grants a person holds', async () => {
    const user = await addUser('developer');
    await addNode('node-a', null);
    await grant(user, 'organization', ORG, 'read');
    await grant(user, 'node', 'node-a', 'admin');
    const grants = await grantsFor(pool, ORG, user);
    expect(grants).toHaveLength(2);
    expect(grants).toContainEqual({ scope_type: 'organization', scope_id: ORG, role: 'read' });
    expect(grants).toContainEqual({ scope_type: 'node', scope_id: 'node-a', role: 'admin' });
  });
});
