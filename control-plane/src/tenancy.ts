/** Tenant identity shared by migrations, compatibility mode, and bootstrap. */
export const BOOTSTRAP_ORGANIZATION_ID = 'org_bootstrap';

export type Role = 'owner' | 'admin' | 'developer' | 'viewer';

export type Permission =
  | 'organization.read'
  | 'organization.manage'
  | 'member.read'
  | 'member.manage'
  | 'member.grant_owner'
  | 'invitation.manage'
  | 'node.read'
  | 'node.manage'
  | 'project.read'
  | 'project.manage'
  | 'run.read'
  | 'run.create'
  | 'run.manage_any'
  | 'run.manage_own'
  | 'audit.read';

const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  owner: new Set<Permission>([
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
  ]),
  admin: new Set<Permission>([
    'organization.read',
    'member.read',
    'member.manage',
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
  ]),
  developer: new Set<Permission>([
    'organization.read',
    'node.read',
    'project.read',
    'run.read',
    'run.create',
    'run.manage_own',
  ]),
  viewer: new Set<Permission>(['organization.read', 'node.read', 'project.read', 'run.read']),
};

/** Centralized, default-deny role authorization. */
export function roleAllows(role: string, permission: Permission): boolean {
  if (!(role in ROLE_PERMISSIONS)) return false;
  return ROLE_PERMISSIONS[role as Role].has(permission);
}

export function permissionsFor(role: string): Permission[] {
  if (!(role in ROLE_PERMISSIONS)) return [];
  return [...ROLE_PERMISSIONS[role as Role]].sort();
}
