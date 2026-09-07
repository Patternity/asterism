/**
 * What a person may do with one resource.
 *
 * Access is a tree — Organization, then the Nodes inside it — and a grant made
 * above applies to everything beneath. A Project has no grants of its own: it is
 * reached through the Node it runs on, because that is where it lives and who
 * supervises it is not a separate question.
 *
 * Two rules decide everything here, and both are deliberate:
 *
 * **The strongest applicable grant wins.** Not the most specific one. Somebody
 * with `write` on the organization keeps `write` on every Node in it, and a
 * narrower `read` on one Node does not take that away. The consequence is worth
 * stating plainly rather than discovering: *a broad grant cannot be narrowed
 * later*. "Write everywhere, but read-only on this one machine" is not
 * expressible, and the way to arrange it is to not grant broadly in the first
 * place. Making it expressible needs a third thing — an explicit deny — and that
 * is the point where a model people can hold in their heads stops being one.
 *
 * **Ownership is not a grant.** The organization's owners, and a Node's owner,
 * hold `admin` on their resource by being who they are. It is not a row, it
 * cannot be revoked by deleting one, and it does not disappear because somebody
 * tidied the permissions table.
 */

import type { Queryable } from './repositories.js';

/** Ordered: each role contains the one before it. */
export type AccessRole = 'read' | 'write' | 'admin';

const RANK: Readonly<Record<AccessRole, number>> = { read: 1, write: 2, admin: 3 };

export type ScopeType = 'organization' | 'node';

export interface Grant {
  scope_type: ScopeType;
  scope_id: string;
  role: AccessRole;
}

/** Whether `held` is at least `needed`. */
export function satisfies(held: AccessRole | null, needed: AccessRole): boolean {
  return held !== null && RANK[held] >= RANK[needed];
}

/** The stronger of two roles, either of which may be absent. */
export function strongest(a: AccessRole | null, b: AccessRole | null): AccessRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * What a person holds on one Node, given everything relevant about them.
 *
 * Written as a pure function over already-fetched facts rather than as a query,
 * so the rule can be read and tested on its own. The place that gets
 * authorization wrong is never the algebra — it is a caller that forgot to ask.
 * Keeping the algebra small and obvious is what leaves attention for that.
 */
export function nodeAccess(input: {
  /** Owners of the organization the Node belongs to. */
  isOrganizationOwner: boolean;
  /** Whether this person is recorded as the Node's owner. */
  isNodeOwner: boolean;
  /** Every grant this person holds that could apply to this Node. */
  grants: readonly Grant[];
  organizationId: string;
  nodeId: string;
}): AccessRole | null {
  // Ownership first, and unconditionally. It is a fact about the resource, not
  // a row that could have been deleted.
  if (input.isOrganizationOwner || input.isNodeOwner) return 'admin';

  let held: AccessRole | null = null;
  for (const grant of input.grants) {
    const applies =
      (grant.scope_type === 'organization' && grant.scope_id === input.organizationId) ||
      (grant.scope_type === 'node' && grant.scope_id === input.nodeId);
    if (applies) held = strongest(held, grant.role);
  }
  return held;
}

/**
 * What a person holds on a Project.
 *
 * Entirely the Node's answer. A Project is not a scope: granting on one would
 * mean a Node owner could be locked out of a Project running on their own
 * machine, which is not a thing this tree can express and not a thing anybody
 * asked for.
 */
export function projectAccess(nodeRole: AccessRole | null): AccessRole | null {
  return nodeRole;
}

/** Every grant a person holds in one organization. */
export async function grantsFor(
  db: Queryable,
  organizationId: string,
  userId: string,
): Promise<Grant[]> {
  const result = await db.query<Grant>(
    `SELECT scope_type, scope_id, role
       FROM permissions
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  );
  return result.rows;
}

/**
 * The Nodes a person may reach at `needed` or better, as ids.
 *
 * Answered in one query so a listing can filter in the database rather than
 * fetching everything and discarding what it should not have read. Fetching
 * first is how a leak becomes invisible: the rows were already in the process,
 * and only the rendering was careful.
 */
export async function readableNodeIds(
  db: Queryable,
  organizationId: string,
  userId: string,
  needed: AccessRole,
): Promise<{ all: boolean; ids: string[] }> {
  const rank = RANK[needed];

  // An organization owner reaches everything, and says so without a second
  // query: `all` means "do not filter", which is both faster and impossible to
  // get subtly wrong by returning a list that happened to be complete.
  const owner = await db.query<{ present: number }>(
    `SELECT 1 FROM memberships
      WHERE organization_id = $1 AND user_id = $2 AND role = 'owner' AND disabled_at IS NULL`,
    [organizationId, userId],
  );
  if (owner.rows.length > 0) return { all: true, ids: [] };

  const organizationGrant = await db.query<{ role: AccessRole }>(
    `SELECT role FROM permissions
      WHERE organization_id = $1 AND user_id = $2
        AND scope_type = 'organization' AND scope_id = $1`,
    [organizationId, userId],
  );
  const held = organizationGrant.rows[0]?.role ?? null;
  if (satisfies(held, needed)) return { all: true, ids: [] };

  // Otherwise: the Nodes they own, plus the Nodes they hold a strong enough
  // grant on. Ownership is `admin`, so it always clears the bar.
  const rows = await db.query<{ node_id: string; owned: boolean; role: AccessRole | null }>(
    `SELECT n.node_id,
            (n.owner_user_id = $2) AS owned,
            p.role
       FROM nodes n
       LEFT JOIN permissions p
         ON p.scope_type = 'node' AND p.scope_id = n.node_id AND p.user_id = $2
      WHERE n.organization_id = $1
        AND (n.owner_user_id = $2 OR p.role IS NOT NULL)`,
    [organizationId, userId],
  );
  const ids = rows.rows
    .filter((row) => row.owned || (row.role !== null && RANK[row.role] >= rank))
    .map((row) => row.node_id);
  return { all: false, ids };
}
