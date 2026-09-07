import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { grantsFor, readableNodeIds, type AccessRole } from '../../src/access.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';

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
  it('refuses every scope but a Node', async () => {
    const user = await addUser('developer');
    await expect(grant(user, 'project', 'prj_1', 'read')).rejects.toThrow();
    // The organization level is the membership role now, not a row here: two
    // records of one thing is what let a demoted member keep their old access.
    await expect(grant(user, 'organization', ORG, 'admin')).rejects.toThrow();
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

describe('which Nodes a person may reach', () => {
  it('an organization owner reaches all of them without a listing', async () => {
    const owner = await addUser('owner');
    await addNode('node-a', null);
    await addNode('node-b', null);
    expect(await readableNodeIds(pool, ORG, owner, 'admin')).toEqual({ all: true, ids: [] });
  });

  it('a membership strong enough reaches all of them', async () => {
    const user = await addUser('developer');
    await addNode('node-a', null);
    expect(await readableNodeIds(pool, ORG, user, 'write')).toEqual({ all: true, ids: [] });
    expect(await readableNodeIds(pool, ORG, user, 'read')).toEqual({ all: true, ids: [] });
  });

  /**
   * The case the whole tree exists for: two people, two machines, neither
   * reaching the other's.
   */
  it('a Node owner reaches their own and no one else', async () => {
    // `viewer`, so the membership does not already reach everything.
    const alice = await addUser('viewer');
    const bob = await addUser('viewer');
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
    const user = await addUser(null);
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

  it('a membership too weak falls back to what is granted per Node', async () => {
    const user = await addUser('viewer');
    await addNode('node-a', null);
    await addNode('node-b', null);
    await grant(user, 'node', 'node-b', 'admin');

    // `viewer` is worth `read` everywhere.
    expect(await readableNodeIds(pool, ORG, user, 'read')).toEqual({ all: true, ids: [] });
    // Beyond that, only where a Node grant says so.
    expect(await readableNodeIds(pool, ORG, user, 'admin')).toEqual({
      all: false,
      ids: ['node-b'],
    });
  });

  it('somebody with nothing reaches nothing', async () => {
    const user = await addUser(null);
    await addNode('node-a', null);
    expect(await readableNodeIds(pool, ORG, user, 'read')).toEqual({ all: false, ids: [] });
  });

  it('reads back exactly the grants a person holds', async () => {
    const user = await addUser('developer');
    await addNode('node-a', null);
    await addNode('node-b', null);
    await grant(user, 'node', 'node-a', 'admin');
    await grant(user, 'node', 'node-b', 'read');
    const grants = await grantsFor(pool, ORG, user);
    expect(grants).toHaveLength(2);
    expect(grants).toContainEqual({ scope_type: 'node', scope_id: 'node-a', role: 'admin' });
    expect(grants).toContainEqual({ scope_type: 'node', scope_id: 'node-b', role: 'read' });
  });
});
