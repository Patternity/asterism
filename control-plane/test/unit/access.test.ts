import { describe, expect, it } from 'vitest';

import {
  nodeAccess,
  projectAccess,
  roleFromMembership,
  satisfies,
  strongest,
  type AccessRole,
  type Grant,
} from '../../src/access.js';

const NODE = 'node-a';

function access(overrides: {
  isOrganizationOwner?: boolean;
  isNodeOwner?: boolean;
  organizationRole?: AccessRole | null;
  grants?: Grant[];
  nodeId?: string;
}): AccessRole | null {
  return nodeAccess({
    isOrganizationOwner: overrides.isOrganizationOwner ?? false,
    isNodeOwner: overrides.isNodeOwner ?? false,
    organizationRole: overrides.organizationRole ?? null,
    grants: overrides.grants ?? [],
    nodeId: overrides.nodeId ?? NODE,
  });
}

describe('roles are ordered, not a set', () => {
  it('each role contains the one before it', () => {
    expect(satisfies('admin', 'read')).toBe(true);
    expect(satisfies('admin', 'write')).toBe(true);
    expect(satisfies('write', 'read')).toBe(true);
    expect(satisfies('write', 'admin')).toBe(false);
    expect(satisfies('read', 'write')).toBe(false);
  });

  it('holding nothing satisfies nothing, including read', () => {
    expect(satisfies(null, 'read')).toBe(false);
  });

  it('the stronger of two survives, in either order', () => {
    expect(strongest('read', 'admin')).toBe('admin');
    expect(strongest('admin', 'read')).toBe('admin');
    expect(strongest(null, 'write')).toBe('write');
    expect(strongest('write', null)).toBe('write');
    expect(strongest(null, null)).toBeNull();
  });
});

describe('what a membership is worth', () => {
  it('maps every role, and refuses one it does not know', () => {
    expect(roleFromMembership('owner')).toBe('admin');
    expect(roleFromMembership('admin')).toBe('admin');
    expect(roleFromMembership('developer')).toBe('write');
    expect(roleFromMembership('viewer')).toBe('read');
    // Default-deny: a role this build does not understand grants nothing rather
    // than falling back to something plausible.
    expect(roleFromMembership('superuser')).toBeNull();
    expect(roleFromMembership('')).toBeNull();
  });
});

describe('a grant made above applies below', () => {
  it('the membership reaches every Node in the organization', () => {
    expect(access({ organizationRole: 'write' })).toBe('write');
    expect(access({ organizationRole: 'write', nodeId: 'node-b' })).toBe('write');
    expect(access({ organizationRole: 'write', nodeId: 'node-z' })).toBe('write');
  });

  it('a Node grant reaches only that Node', () => {
    const grants: Grant[] = [{ scope_type: 'node', scope_id: NODE, role: 'write' }];
    expect(access({ grants })).toBe('write');
    expect(access({ grants, nodeId: 'node-b' })).toBeNull();
  });

  it('holding nothing reaches nothing', () => {
    expect(access({})).toBeNull();
  });
});

describe('the strongest applicable grant wins, not the most specific', () => {
  /**
   * The consequence of the rule, asserted rather than left to be discovered:
   * a broad grant cannot be narrowed by a smaller one underneath it. Anyone
   * changing this to most-specific-wins will fail here and have to decide on
   * purpose.
   */
  it('a Node grant does not take away what the membership already gave', () => {
    const grants: Grant[] = [{ scope_type: 'node', scope_id: NODE, role: 'read' }];
    expect(access({ organizationRole: 'write', grants })).toBe('write');
  });

  it('a Node grant does raise a weaker membership', () => {
    const grants: Grant[] = [{ scope_type: 'node', scope_id: NODE, role: 'admin' }];
    expect(access({ organizationRole: 'read', grants })).toBe('admin');
    // And only on that Node.
    expect(access({ organizationRole: 'read', grants, nodeId: 'node-b' })).toBe('read');
  });

  it('order of grants does not change the answer', () => {
    const a: Grant[] = [
      { scope_type: 'node', scope_id: NODE, role: 'admin' },
      { scope_type: 'node', scope_id: 'node-b', role: 'read' },
    ];
    const b = [...a].reverse();
    expect(access({ grants: a })).toBe(access({ grants: b }));
  });
});

describe('ownership is not a grant', () => {
  it("a Node's owner holds admin on it with no row at all", () => {
    expect(access({ isNodeOwner: true })).toBe('admin');
  });

  it('and only on their own Node', () => {
    // `isNodeOwner` is asked about one Node; a caller resolving another Node
    // passes false, and nothing here invents authority for it.
    expect(access({ isNodeOwner: false, nodeId: 'node-b' })).toBeNull();
  });

  it('an organization owner holds admin on every Node', () => {
    expect(access({ isOrganizationOwner: true })).toBe('admin');
    expect(access({ isOrganizationOwner: true, nodeId: 'node-z' })).toBe('admin');
  });

  it('ownership outranks a weaker membership rather than being averaged with it', () => {
    expect(access({ isNodeOwner: true, organizationRole: 'read' })).toBe('admin');
  });
});

describe('a Project is reached through its Node', () => {
  it('carries the Node answer unchanged, including nothing', () => {
    expect(projectAccess('admin')).toBe('admin');
    expect(projectAccess('write')).toBe('write');
    expect(projectAccess('read')).toBe('read');
    expect(projectAccess(null)).toBeNull();
  });
});
