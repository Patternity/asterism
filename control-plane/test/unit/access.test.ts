import { describe, expect, it } from 'vitest';

import {
  nodeAccess,
  projectAccess,
  satisfies,
  strongest,
  type AccessRole,
  type Grant,
} from '../../src/access.js';

const ORG = 'org_one';
const NODE = 'node-a';

function access(overrides: {
  isOrganizationOwner?: boolean;
  isNodeOwner?: boolean;
  grants?: Grant[];
  nodeId?: string;
}): AccessRole | null {
  return nodeAccess({
    isOrganizationOwner: overrides.isOrganizationOwner ?? false,
    isNodeOwner: overrides.isNodeOwner ?? false,
    grants: overrides.grants ?? [],
    organizationId: ORG,
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

describe('a grant made above applies below', () => {
  it('an organization grant reaches every Node in it', () => {
    const grants: Grant[] = [{ scope_type: 'organization', scope_id: ORG, role: 'write' }];
    expect(access({ grants })).toBe('write');
    expect(access({ grants, nodeId: 'node-b' })).toBe('write');
    expect(access({ grants, nodeId: 'node-z' })).toBe('write');
  });

  it('a Node grant reaches only that Node', () => {
    const grants: Grant[] = [{ scope_type: 'node', scope_id: NODE, role: 'write' }];
    expect(access({ grants })).toBe('write');
    expect(access({ grants, nodeId: 'node-b' })).toBeNull();
  });

  it('a grant in another organization reaches nothing here', () => {
    const grants: Grant[] = [{ scope_type: 'organization', scope_id: 'org_other', role: 'admin' }];
    expect(access({ grants })).toBeNull();
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
  it('a narrower grant does not take away a broader one', () => {
    const grants: Grant[] = [
      { scope_type: 'organization', scope_id: ORG, role: 'write' },
      { scope_type: 'node', scope_id: NODE, role: 'read' },
    ];
    expect(access({ grants })).toBe('write');
  });

  it('a narrower grant does raise a weaker broad one', () => {
    const grants: Grant[] = [
      { scope_type: 'organization', scope_id: ORG, role: 'read' },
      { scope_type: 'node', scope_id: NODE, role: 'admin' },
    ];
    expect(access({ grants })).toBe('admin');
    // And only on that Node.
    expect(access({ grants, nodeId: 'node-b' })).toBe('read');
  });

  it('order of grants does not change the answer', () => {
    const a: Grant[] = [
      { scope_type: 'node', scope_id: NODE, role: 'admin' },
      { scope_type: 'organization', scope_id: ORG, role: 'read' },
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

  it('ownership outranks a weaker grant rather than being averaged with it', () => {
    const grants: Grant[] = [{ scope_type: 'organization', scope_id: ORG, role: 'read' }];
    expect(access({ isNodeOwner: true, grants })).toBe('admin');
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
