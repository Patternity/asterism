import { expect, test, type Page, type Route } from '@playwright/test';

const organizations = [
  { organization_id: 'org-a', slug: 'alpha', display_name: 'Alpha', role: 'owner' },
  { organization_id: 'org-b', slug: 'beta', display_name: 'Beta', role: 'owner' },
];

const permissions = [
  'organization.read',
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

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockProductApi(
  page: Page,
  options: {
    userId?: string;
    role?: string;
    permissions?: string[];
    runCreator?: string;
    runFailure?: { status: string; error_code: string | null; error_message: string | null };
  } = {},
) {
  let active = organizations[0]!;
  const userId = options.userId ?? 'owner';
  const grantedPermissions = options.permissions ?? permissions;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/auth/session') {
      return json(route, {
        user: { user_id: userId, email: `${userId}@example.com`, display_name: userId },
        active_organization: { ...active, role: options.role ?? active.role },
        permissions: grantedPermissions,
      });
    }
    if (path === '/api/v1/organizations') return json(route, { organizations });
    if (path === '/api/v1/organizations/select') {
      const body = request.postDataJSON() as { organization_id: string };
      active = organizations.find(
        (organization) => organization.organization_id === body.organization_id,
      )!;
      return json(route, {
        user: { user_id: userId, email: `${userId}@example.com`, display_name: userId },
        active_organization: { ...active, role: options.role ?? active.role },
        permissions: grantedPermissions,
        csrf_token: 'rotated',
      });
    }
    if (path === '/api/v1/overview')
      return json(route, {
        counts: {
          online_nodes: 1,
          offline_nodes: 0,
          draining_nodes: 0,
          enabled_projects: 1,
          active_runs: 1,
          waiting_approvals: 1,
        },
        recent_problem_runs: [],
      });
    if (path === '/api/v1/nodes')
      return json(route, {
        nodes: [
          {
            node_id: `node-${active.slug}`,
            display_name: `${active.display_name} Node`,
            connection_state: 'online',
            last_seen_at: new Date().toISOString(),
            software_version: '0.1.0',
          },
        ],
      });
    if (path.startsWith('/api/v1/nodes/'))
      return json(route, {
        node: {
          node_id: `node-${active.slug}`,
          display_name: `${active.display_name} Node`,
          connection_state: 'online',
          last_seen_at: new Date().toISOString(),
          software_version: '0.1.0',
          protocol_version: 1,
          identity_generation: 1,
          fingerprint: 'a'.repeat(64),
          capabilities: { runs: true },
          draining: false,
          revoked_at: null,
        },
        projects: [],
      });
    if (path === '/api/v1/projects')
      return json(route, {
        projects: [
          {
            project_id: `project-${active.slug}`,
            node_id: `node-${active.slug}`,
            node_project_id: 'workspace',
            display_name: `${active.display_name} Project`,
            enabled: true,
            available: true,
            first_seen_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            metadata: {},
          },
        ],
      });
    if (path.startsWith('/api/v1/projects/'))
      return json(route, {
        project: {
          project_id: `project-${active.slug}`,
          node_id: `node-${active.slug}`,
          node_project_id: 'workspace',
          display_name: `${active.display_name} Project`,
          enabled: true,
          available: true,
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          metadata: {},
        },
        node: { node_id: `node-${active.slug}`, display_name: `${active.display_name} Node` },
        active_run: null,
        recent_runs: [],
      });
    if (path.endsWith('/events/stream'))
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'id: 1\nevent: message.delta\ndata: {"run_id":"run-1","seq":1,"event_type":"message.delta","recorded_at":null,"ingested_at":"2026-01-01T00:00:00Z","payload":{"text":"Hello from agent"}}\n\n',
      });
    if (path.endsWith('/events')) return json(route, { events: [] });
    if (path === '/api/v1/runs')
      return json(route, {
        runs: [
          {
            run_id: 'run-1',
            node_id: `node-${active.slug}`,
            project_id: `project-${active.slug}`,
            node_run_id: 'arun-1',
            status: 'waiting_for_approval',
            request_metadata: { input_length: 12 },
            created_by_user_id: options.runCreator ?? userId,
            created_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            finished_at: null,
            terminal_reason: null,
            error_code: null,
            error_message: null,
            retry_of_run_id: null,
            last_event_seq: 1,
          },
        ],
      });
    if (path === '/api/v1/runs/run-1')
      return json(route, {
        run: {
          run_id: 'run-1',
          node_id: `node-${active.slug}`,
          project_id: `project-${active.slug}`,
          node_run_id: 'arun-1',
          status: options.runFailure?.status ?? 'running',
          request_metadata: { input_length: 12 },
          created_by_user_id: options.runCreator ?? userId,
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          finished_at: null,
          terminal_reason: null,
          error_code: options.runFailure?.error_code ?? null,
          error_message: options.runFailure?.error_message ?? null,
          retry_of_run_id: null,
          last_event_seq: 1,
        },
      });
    if (path === '/api/v1/members')
      return json(route, {
        members: [
          {
            user_id: 'owner',
            email: 'owner@example.com',
            display_name: 'Owner',
            enabled: true,
            role: 'owner',
            disabled_at: null,
          },
        ],
      });
    if (path === '/api/v1/invitations') return json(route, { invitations: [] });
    if (path === '/api/v1/audit') return json(route, { entries: [] });
    return json(route, {});
  });
}

test('all operations pages render and organization switching clears tenant views', async ({
  page,
}) => {
  await mockProductApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.getByRole('link', { name: 'Nodes' }).click();
  await expect(page.getByText('Alpha Node')).toBeVisible();
  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByText('Alpha Project')).toBeVisible();
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByRole('heading', { name: 'Members and invitations' })).toBeVisible();
  await page.getByRole('link', { name: 'Audit' }).click();
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();

  await page.getByLabel('Organization').selectOption('org-b');
  await page.getByRole('link', { name: 'Nodes' }).click();
  await expect(page.getByText('Beta Node')).toBeVisible();
  await expect(page.getByText('Alpha Node')).toHaveCount(0);
});

test('run detail streams assistant output and exposes honest connection state', async ({
  page,
}) => {
  await mockProductApi(page);
  await page.goto('/runs/run-1');
  await expect(page.getByRole('heading', { name: /Run run-1/ })).toBeVisible();
  await expect(page.getByText('Hello from agent')).toBeVisible();
  await expect(page.getByText(/Stream (connected|reconnecting)/)).toBeVisible();
});

test('role controls follow server permissions and Developer ownership', async ({ page }) => {
  await mockProductApi(page, {
    userId: 'admin',
    role: 'admin',
    permissions: ['organization.read', 'member.read', 'member.manage', 'invitation.manage'],
  });
  await page.goto('/members');
  await expect(page.getByRole('heading', { name: 'Members and invitations' })).toBeVisible();
  await expect(page.getByLabel('Role').locator('option', { hasText: 'owner' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible();

  await page.unroute('**/api/v1/**');
  await mockProductApi(page, {
    userId: 'developer',
    role: 'developer',
    permissions: ['organization.read', 'node.read', 'project.read', 'run.read', 'run.manage_own'],
    runCreator: 'someone-else',
  });
  await page.goto('/runs/run-1');
  await expect(page.getByText('Your role cannot mutate this run.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
});

test('Owner receives Node management controls while Viewer remains read-only', async ({ page }) => {
  await mockProductApi(page);
  await page.goto('/nodes/node-alpha');
  await expect(page.getByRole('button', { name: 'Drain' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke' })).toBeVisible();

  await page.unroute('**/api/v1/**');
  await mockProductApi(page, {
    userId: 'viewer',
    role: 'viewer',
    permissions: ['organization.read', 'node.read', 'project.read', 'run.read'],
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Drain' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
});

test('a failed run shows why it ended instead of only an empty output panel', async ({ page }) => {
  await mockProductApi(page, {
    runFailure: {
      status: 'failed',
      error_code: null,
      error_message:
        '⚠️ Provider authentication failed: Codex provider quota exhausted (429); retry after 5932s. Credentials are still valid.',
    },
  });
  await page.goto('/runs/run-1');

  await expect(page.getByRole('heading', { name: 'Why it ended' })).toBeVisible();
  await expect(page.getByText('Codex provider quota exhausted')).toBeVisible();
});

test('a run with nothing wrong shows no reason panel', async ({ page }) => {
  await mockProductApi(page);
  await page.goto('/runs/run-1');

  await expect(page.getByRole('heading', { name: 'Assistant output' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Why it ended' })).toHaveCount(0);
});
