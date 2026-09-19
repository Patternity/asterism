import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * What the credentials panel does after it asks for something.
 *
 * Everything here was invisible in production: a login whose code took longer
 * than the panel's own window, and refusals the panel never showed because it
 * stopped at the `202`. The Control Plane is mocked, so what is under test is
 * the page's behaviour: what it asks for, how long it keeps watching, and what
 * it does with the answer.
 */

const NODE = 'node-under-test';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface World {
  /** Credentials the Node reports, per detail request (the last repeats). */
  credentials: unknown[][];
  /** The relay's answer, per poll (the last repeats). */
  device: (unknown | null)[];
  /** How the command the panel started ends, per poll (the last repeats). */
  outcome: Record<string, unknown>[];
  managedUpdate?: boolean;
  softwareVersion?: string;
  currentVersion?: string | null;
  reauthorization?: boolean;
  projects?: unknown[];
}

interface Counts {
  detail: number;
  device: number;
  outcome: number;
  posts: string[];
}

function step<T>(values: T[], index: number): T {
  return values[Math.min(index, values.length - 1)]!;
}

async function mock(page: Page, world: World): Promise<Counts> {
  const counts: Counts = { detail: 0, device: 0, outcome: 0, posts: [] };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      counts.posts.push(path);
      return json(route, { node_id: NODE, command_id: 'cmd-under-test' }, 202);
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
        permissions: ['node.manage', 'node.read', 'project.read'],
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
    if (path.endsWith('/provider-authorization')) {
      const device = step(world.device, counts.device);
      counts.device += 1;
      return json(route, { device });
    }
    if (path.includes('/commands/')) {
      const outcome = step(world.outcome, counts.outcome);
      counts.outcome += 1;
      return json(route, { command_id: 'cmd-under-test', ...outcome });
    }
    if (path === `/api/v1/nodes/${NODE}`) {
      const credentials = step(world.credentials, counts.detail);
      counts.detail += 1;
      return json(route, {
        node: {
          node_id: NODE,
          display_name: 'Test Node',
          connection_state: 'online',
          last_seen_at: new Date().toISOString(),
          software_version: world.softwareVersion ?? 'v0.1.0-alpha.32',
          protocol_version: 1,
          identity_generation: 1,
          fingerprint: 'a'.repeat(64),
          capabilities: {},
          provider_state: 'authorized',
          draining: false,
        },
        projects: world.projects ?? [],
        current_node_version: world.currentVersion ?? 'v0.1.0-alpha.33',
        current_node_release: null,
        update_operation: null,
        node_capabilities: {
          connection_status: 'online',
          capabilities_known: true,
          run_approval_policy: [],
          supports_run_approval_policy: false,
          run_approval_policy_available: false,
          run_attachments: [],
          image_attachments_available: false,
          supports_project_provisioning: true,
          project_provisioning_available: true,
          workspace_modes: ['empty'],
          supports_project_credentials: true,
          supports_project_models: true,
          supports_managed_update: world.managedUpdate !== false,
          managed_update_available: world.managedUpdate !== false,
          supports_credential_reauthorization: world.reauthorization !== false,
          credential_reauthorization_available: world.reauthorization !== false,
        },
        provider_capabilities: AVAILABLE,
        credentials,
      });
    }
    if (path.startsWith('/api/v1/nodes')) return json(route, { nodes: [] });
    return json(route, {});
  });
  return counts;
}

const AVAILABLE = {
  state: 'reported',
  status: 'ok',
  schema_version: 2,
  runtime_release: 'v0.1.0-alpha.32',
  providers: [
    {
      id: 'openai-codex',
      display_name: 'OpenAI Codex',
      auth_methods: ['device_authorization'],
      availability: 'available',
      models: [],
    },
  ],
  reported_at: '2026-09-18T10:00:00.000Z',
  recorded_at: '2026-09-18T10:00:05.000Z',
  stale: false,
};

function credential(overrides: Record<string, unknown> = {}) {
  return {
    credential_id: 'cred-0011aabb',
    provider_id: 'openai-codex',
    auth_method: 'device_authorization',
    label: 'Work account',
    state: 'authorized',
    storage: 'isolated',
    ...overrides,
  };
}

function panel(page: Page) {
  return page.getByRole('article').filter({ hasText: 'Provider credentials' }).first();
}

const CODE = {
  verification_uri: 'https://auth.example.test/device',
  user_code: 'SLOW-0001',
  expires_at: new Date(Date.now() + 900_000).toISOString(),
};

/**
 * The production failure: the provider took over a minute. The panel used to
 * stop looking after sixty seconds and showed nothing at all.
 */
test('shows a code that arrives long after the login was started', async ({ page }) => {
  // Deliberately longer than the minute the panel used to give up after: the
  // point of the test is the wait, so the test is allowed to take it.
  test.setTimeout(180_000);
  const authorizing = [credential({ state: 'authorizing', label: 'New account' })];
  const counts = await mock(page, {
    credentials: [[], authorizing],
    // Nothing for the first twenty-five polls -- past a minute at three
    // seconds each -- and then the code.
    device: [...Array<null>(25).fill(null), CODE],
    outcome: [{ state: 'completed', terminal: true, failure: null }],
  });
  await page.goto(`/nodes/${NODE}`);

  await panel(page)
    .getByRole('button', { name: /Add OpenAI Codex credential/ })
    .click();
  await page.getByRole('button', { name: 'Start authorization' }).click();

  await expect(panel(page).getByText(/Waiting for this Node to hand back a code/)).toBeVisible();
  await expect(panel(page).getByText('SLOW-0001')).toBeVisible({ timeout: 120_000 });
  expect(counts.device).toBeGreaterThan(20);
});

test('shows why the Node refused a revoke instead of pretending it worked', async ({ page }) => {
  await mock(page, {
    credentials: [[credential()]],
    device: [null],
    outcome: [
      { state: 'dispatched', terminal: false, failure: null },
      {
        state: 'failed',
        terminal: true,
        failure: {
          code: 'credential_in_use',
          message:
            'That credential is still used by a project. Move the project to another credential first.',
        },
      },
    ],
  });
  await page.goto(`/nodes/${NODE}`);

  await panel(page).getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Revoke credential' }).click();

  await expect(panel(page).getByText(/Waiting for this Node to carry it out/)).toBeVisible();
  await expect(panel(page).getByRole('alert')).toContainText('still used by a project');
});

test('shows a second login refused because one is already waiting', async ({ page }) => {
  await mock(page, {
    credentials: [[credential({ state: 'authorizing', label: 'First' })]],
    device: [null],
    outcome: [
      {
        state: 'failed',
        terminal: true,
        failure: {
          code: 'authorization_in_progress',
          message:
            'This Node is already waiting for a browser approval. Cancel that one before starting another.',
        },
      },
    ],
  });
  await page.goto(`/nodes/${NODE}`);

  // The panel offers cancelling the one in flight; refusing a second is what
  // the Control Plane answers when something else asks.
  await panel(page).getByRole('button', { name: 'Cancel this authorization' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('already waiting for a browser');
});

test('stops watching once the attempt is no longer waiting', async ({ page }) => {
  const counts = await mock(page, {
    // Waiting at first, settled from the second detail request on.
    credentials: [[credential({ state: 'authorizing', label: 'New account' })], [credential()]],
    device: [CODE, null],
    outcome: [{ state: 'completed', terminal: true, failure: null }],
  });
  await page.goto(`/nodes/${NODE}`);

  await expect(panel(page).getByText('SLOW-0001')).toBeVisible();
  await expect(panel(page).getByText('Ready')).toBeVisible({ timeout: 15_000 });
  const settled = counts.device;
  await page.waitForTimeout(6_000);
  expect(counts.device).toBe(settled);
});

test('offers no update for a Node whose build cannot take one', async ({ page }) => {
  await mock(page, {
    credentials: [[credential()]],
    device: [null],
    outcome: [{ state: 'completed', terminal: true, failure: null }],
    managedUpdate: false,
  });
  await page.goto(`/nodes/${NODE}`);

  await expect(page.getByRole('button', { name: /Update to/ })).toHaveCount(0);
  await expect(page.getByText(/cannot be updated from here/)).toBeVisible();
});

test('still offers an update for a Node that advertises it', async ({ page }) => {
  await mock(page, {
    credentials: [[credential()]],
    device: [null],
    outcome: [{ state: 'completed', terminal: true, failure: null }],
    managedUpdate: true,
  });
  await page.goto(`/nodes/${NODE}`);

  await expect(page.getByRole('button', { name: /Update to v0.1.0-alpha.33/ })).toBeVisible();
});

/**
 * The button follows the Control Plane's decision and nothing else.
 *
 * Both halves matter. node-2 runs `0.1.0`, is ineligible, and must be offered
 * nothing; a legacy Node the Control Plane has judged eligible on an accepted
 * update must still be offered one. A console that read the version string
 * would get one of these two wrong, and that guess is what put an operator in
 * front of an update that timed out.
 */
test('offers nothing for node-2, whatever its version reads like', async ({ page }) => {
  await mock(page, {
    credentials: [[credential()]],
    device: [null],
    outcome: [{ state: 'completed', terminal: true, failure: null }],
    softwareVersion: '0.1.0',
    managedUpdate: false,
  });
  await page.goto(`/nodes/${NODE}`);

  await expect(page.getByText('0.1.0')).toBeVisible();
  await expect(page.getByRole('button', { name: /Update to/ })).toHaveCount(0);
  await expect(page.getByText(/cannot be updated from here/)).toBeVisible();
});

test('still offers one to a legacy Node the Control Plane judged eligible', async ({ page }) => {
  await mock(page, {
    credentials: [[credential()]],
    device: [null],
    outcome: [{ state: 'completed', terminal: true, failure: null }],
    // An old build with no `updates` in its capabilities, eligible because the
    // last update it was asked for is one it took.
    softwareVersion: 'v0.1.0-alpha.29',
    managedUpdate: true,
  });
  await page.goto(`/nodes/${NODE}`);

  await expect(page.getByRole('button', { name: /Update to v0.1.0-alpha.33/ })).toBeVisible();
  await expect(page.getByText(/cannot be updated from here/)).toHaveCount(0);
});

/**
 * Logging an existing credential in again.
 *
 * The same credential stays on the page throughout: nothing is replaced, so
 * nothing new appears and nothing the operator recognises goes away.
 */
test('offers a login for the credential whose provider access ended', async ({ page }) => {
  const counts = await mock(page, {
    credentials: [
      [credential({ state: 'reauthorization_required', label: 'Work account' })],
      [credential({ state: 'reauthorizing', label: 'Work account' })],
    ],
    device: [null, CODE],
    outcome: [{ state: 'completed', terminal: true, failure: null }],
    projects: [
      { project_id: 'prj_one', display_name: 'Ship it', credential_id: 'cred-0011aabb' },
      { project_id: 'prj_two', display_name: 'Other work', credential_id: 'cred-0011aabb' },
    ],
  });
  await page.goto(`/nodes/${NODE}`);

  // The state is shown honestly, and so is what it costs.
  await expect(panel(page).getByText('Provider access ended')).toBeVisible();
  await expect(panel(page).getByText(/New runs are blocked for Ship it, Other work/)).toBeVisible();

  await panel(page).getByRole('button', { name: 'Reauthorize' }).click();
  await page.getByRole('button', { name: 'Start authorization' }).click();

  // It asks about the credential that exists, and asks for no new one.
  expect(counts.posts).toEqual([`/api/v1/nodes/${NODE}/credentials/cred-0011aabb/reauthorize`]);
  // The same credential is still the one on the page, now waiting.
  await expect(panel(page).getByText('Work account')).toBeVisible();
  await expect(panel(page).getByText('SLOW-0001')).toBeVisible({ timeout: 15_000 });
});

test('says a runtime record is missing rather than calling it revoked', async ({ page }) => {
  await mock(page, {
    credentials: [[credential({ state: 'runtime_missing', label: 'Work account' })]],
    device: [null],
    outcome: [{ state: 'completed', terminal: true, failure: null }],
  });
  await page.goto(`/nodes/${NODE}`);

  // Scoped to the credential's own entry: the panel's opening sentence
  // mentions revoking, and a page-wide search for the word finds that instead
  // of anything about this credential.
  const entry = panel(page).locator('dd').filter({ hasText: 'openai-codex' }).first();
  await expect(entry).toContainText('Not held by this Node');
  await expect(entry).not.toContainText('Revoked');
  await expect(panel(page).getByRole('button', { name: 'Reauthorize' })).toBeVisible();
});

test('shows a rollback the Node reported instead of pretending it worked', async ({ page }) => {
  await mock(page, {
    credentials: [[credential({ state: 'reauthorization_required', label: 'Work account' })]],
    device: [null],
    outcome: [
      { state: 'dispatched', terminal: false, failure: null },
      {
        state: 'failed',
        terminal: true,
        failure: {
          code: 'worker_unhealthy',
          message:
            'A project using this credential did not come back after the change, so the previous credential was put back.',
        },
      },
    ],
  });
  await page.goto(`/nodes/${NODE}`);

  await panel(page).getByRole('button', { name: 'Reauthorize' }).click();
  await page.getByRole('button', { name: 'Start authorization' }).click();

  await expect(panel(page).getByRole('alert')).toContainText('previous credential was put back');
});

test('offers no login for a Node whose build cannot do it', async ({ page }) => {
  await mock(page, {
    credentials: [[credential({ state: 'reauthorization_required' })]],
    device: [null],
    outcome: [{ state: 'completed', terminal: true, failure: null }],
    reauthorization: false,
  });
  await page.goto(`/nodes/${NODE}`);

  await expect(panel(page).getByText('Provider access ended')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Reauthorize' })).toHaveCount(0);
});
