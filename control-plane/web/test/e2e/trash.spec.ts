import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Trash in the console.
 *
 * The Control Plane is mocked, so what is under test is the page: that the
 * tree reads the way the hierarchy works, that restore is offered only where
 * it means something, that a person is told what moving something means before
 * it moves, and that a refusal or a worker still on its way is shown rather
 * than smoothed over.
 */

const ACTIVE_NODE = 'node-active';
const TRASHED_NODE = 'node-trashed';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const projectTrash = (overrides: Record<string, unknown>) => ({
  trashed: false,
  inherited: false,
  effective: true,
  trashed_at: null,
  node_trashed_at: null,
  worker: null,
  worker_failure: null,
  ...overrides,
});

/** One Node in Trash with two projects, one active Node holding one. */
const TREE = {
  nodes: [
    {
      node_id: TRASHED_NODE,
      display_name: 'Retired host',
      connection_state: 'online',
      role: 'trashed',
      trash: { trashed: true, trashed_at: '2026-09-22T10:00:00Z', trashed_by_user_id: 'owner' },
      projects: [
        {
          project_id: 'prj_inherited',
          display_name: 'Came along',
          trash: projectTrash({ inherited: true, worker: 'stopped' }),
        },
        {
          project_id: 'prj_both',
          display_name: 'Put away first',
          trash: projectTrash({ trashed: true, inherited: true, worker: 'stopped' }),
        },
      ],
    },
    {
      node_id: ACTIVE_NODE,
      display_name: 'Working host',
      connection_state: 'online',
      role: 'context',
      trash: { trashed: false, trashed_at: null, trashed_by_user_id: null },
      projects: [
        {
          project_id: 'prj_own',
          display_name: 'Set aside',
          trash: projectTrash({ trashed: true, worker: 'stopping' }),
        },
      ],
    },
  ],
};

interface World {
  tree?: unknown;
  /** How a lifecycle POST is answered. */
  reply?: { status: number; body: unknown };
  project?: Record<string, unknown>;
}

async function mock(page: Page, world: World = {}) {
  const posts: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      posts.push(path);
      const reply = world.reply ?? { status: 200, body: { outcome: 'restored' } };
      return json(route, reply.body, reply.status);
    }
    if (path === '/api/v1/auth/session') {
      return json(route, {
        user: { user_id: 'owner', email: 'owner@example.com', display_name: 'owner' },
        active_organization: {
          organization_id: 'org_bootstrap',
          slug: 'bootstrap',
          display_name: 'Bootstrap',
          role: 'owner',
        },
        permissions: ['node.manage', 'node.read', 'project.read', 'project.manage'],
      });
    }
    if (path === '/api/v1/organizations') {
      return json(route, {
        organizations: [
          {
            organization_id: 'org_bootstrap',
            slug: 'bootstrap',
            display_name: 'Bootstrap',
            role: 'owner',
          },
        ],
      });
    }
    if (path === '/api/v1/overview') {
      return json(route, {
        counts: {
          online_nodes: 0,
          offline_nodes: 0,
          stale_nodes: 0,
          draining_nodes: 0,
          enabled_projects: 0,
          active_runs: 0,
          waiting_approvals: 0,
        },
        recent_runs: [],
        recent_problem_runs: [],
        waiting_runs: [],
      });
    }
    if (path === '/api/v1/trash') return json(route, world.tree ?? TREE);
    if (path === '/api/v1/projects/prj_page') {
      return json(route, {
        project: world.project,
        node: { node_id: ACTIVE_NODE, display_name: 'Working host', connection_state: 'online' },
        active_run: null,
        recent_runs: [],
      });
    }
    if (path.startsWith('/api/v1/nodes/')) {
      return json(route, {
        node: { node_id: ACTIVE_NODE, display_name: 'Working host' },
        credentials: [],
      });
    }
    if (path.startsWith('/api/v1/nodes') || path.startsWith('/api/v1/projects')) {
      return json(route, { nodes: [], projects: [] });
    }
    if (path.endsWith('/events')) return json(route, { events: [] });
    return json(route, {});
  });
  return posts;
}

function branch(page: Page, name: string) {
  return page.getByRole('article', { name: `Node ${name}` });
}

test('shows Nodes at the top and every project under the Node it belongs to', async ({ page }) => {
  await mock(page);
  await page.goto('/trash');

  const retired = branch(page, 'Retired host');
  await expect(retired.getByText('In Trash, with every project on it.')).toBeVisible();
  await expect(retired.getByRole('button', { name: 'Restore Node' })).toBeVisible();
  // Inherited only, and inherited as well as its own -- said differently.
  await expect(retired.getByText('In Trash with its Node.')).toBeVisible();
  await expect(retired.getByText(/stays in Trash when the Node is restored/)).toBeVisible();
  // Under a Node in Trash, the Node is what is restored.
  await expect(retired.getByRole('button', { name: 'Restore project' })).toHaveCount(0);
  await expect(retired.getByText('Restore its Node first.')).toHaveCount(2);

  const working = branch(page, 'Working host');
  await expect(working.getByText(/Active\. Shown here only for the projects below/)).toBeVisible();
  await expect(working.getByRole('button', { name: 'Restore Node' })).toHaveCount(0);
  await expect(working.getByText('In Trash on its own.')).toBeVisible();
  await expect(working.getByRole('button', { name: 'Restore project' })).toBeVisible();
  // A worker still on its way is said to be, not shown as done.
  await expect(working.getByText(/Stopping its worker — waiting for the Node/)).toBeVisible();
});

test('restores at the level it was asked for', async ({ page }) => {
  const posts = await mock(page);
  await page.goto('/trash');

  await branch(page, 'Working host').getByRole('button', { name: 'Restore project' }).click();
  await expect.poll(() => posts).toEqual(['/api/v1/projects/prj_own/restore']);

  await branch(page, 'Retired host').getByRole('button', { name: 'Restore Node' }).click();
  await expect.poll(() => posts.at(-1)).toBe(`/api/v1/nodes/${TRASHED_NODE}/restore`);
});

test('shows a refused restore instead of pretending it worked', async ({ page }) => {
  await mock(page, {
    reply: {
      status: 409,
      body: {
        error: 'node_trashed',
        message: 'This project is in Trash with its Node. Restore the Node first.',
      },
    },
  });
  await page.goto('/trash');
  await branch(page, 'Working host').getByRole('button', { name: 'Restore project' }).click();
  await expect(page.getByText(/Restore the Node first/)).toBeVisible();
});

test('says what moving a project to Trash means before it moves', async ({ page }) => {
  const posts = await mock(page, {
    project: {
      project_id: 'prj_page',
      name: 'Page project',
      node_id: ACTIVE_NODE,
      enabled: true,
      available: true,
      provisioning: {
        state: 'ready',
        generation: 1,
        failure: null,
        failure_message: null,
        retryable: false,
      },
      can_run: true,
      node_online: true,
      trash: projectTrash({ effective: false }),
    },
  });
  await page.goto('/projects/prj_page');

  await page.getByRole('button', { name: 'Move to Trash' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText(/disappear from Projects, Runs/)).toBeVisible();
  await expect(dialog.getByText(/kept exactly as they are/)).toBeVisible();
  await expect(dialog.getByText(/restore it from Trash at any time/)).toBeVisible();
  await expect(dialog.getByText(/no disk space is freed/)).toBeVisible();
  // No permanent deletion is offered anywhere.
  await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Move project to Trash' }).click();
  await expect.poll(() => posts).toEqual(['/api/v1/projects/prj_page/trash']);
  await expect(page).toHaveURL(/\/trash$/);
});

test('a project reached by id while in Trash with its Node offers no restore of its own', async ({
  page,
}) => {
  await mock(page, {
    project: {
      project_id: 'prj_page',
      name: 'Page project',
      node_id: ACTIVE_NODE,
      enabled: true,
      available: true,
      provisioning: {
        state: 'ready',
        generation: 1,
        failure: null,
        failure_message: null,
        retryable: false,
      },
      can_run: false,
      node_online: true,
      trash: projectTrash({ trashed: true, inherited: true }),
    },
  });
  await page.goto('/projects/prj_page');

  await expect(page.getByText(/This project is in Trash/)).toBeVisible();
  await expect(page.getByText(/Restore its Node first/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore project' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move to Trash' })).toHaveCount(0);
});

test('Trash is one entry in the navigation', async ({ page }) => {
  await mock(page, { tree: { nodes: [] } });
  await page.goto('/');
  await page.getByRole('link', { name: 'Trash', exact: true }).click();
  await expect(page.getByText('Trash is empty.')).toBeVisible();
});
