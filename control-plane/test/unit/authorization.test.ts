import { describe, expect, it } from 'vitest';

import { permissionsFor, roleAllows, type Permission, type Role } from '../../src/tenancy.js';

const ALL_PERMISSIONS: Permission[] = [
  'organization.read',
  'organization.manage',
  'member.read',
  'member.manage',
  'member.grant_owner',
  'invitation.manage',
  'node.read',
  'node.manage',
  'project.read',
  'project.manage',
  'run.read',
  'run.create',
  'run.manage_any',
  'run.manage_own',
  'audit.read',
];

describe('central role authorization', () => {
  const matrix: Record<Role, Permission[]> = {
    owner: ALL_PERMISSIONS,
    admin: ALL_PERMISSIONS.filter(
      (permission) => !['organization.manage', 'member.grant_owner'].includes(permission),
    ),
    developer: [
      'organization.read',
      'node.read',
      'project.read',
      'run.read',
      'run.create',
      'run.manage_own',
    ],
    viewer: ['organization.read', 'node.read', 'project.read', 'run.read'],
  };

  for (const [role, allowed] of Object.entries(matrix) as [Role, Permission[]][]) {
    it(`applies the complete ${role} permission matrix`, () => {
      for (const permission of ALL_PERMISSIONS) {
        expect(roleAllows(role, permission), `${role}:${permission}`).toBe(
          allowed.includes(permission),
        );
      }
      expect(permissionsFor(role)).toEqual([...allowed].sort());
    });
  }

  it('denies unknown roles by default', () => {
    for (const permission of ALL_PERMISSIONS) expect(roleAllows('unknown', permission)).toBe(false);
    expect(permissionsFor('unknown')).toEqual([]);
  });
});
