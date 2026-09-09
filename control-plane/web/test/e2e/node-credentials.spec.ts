import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The Node credentials panel.
 *
 * This phase is credentials on a Node: which exist, making one, naming it,
 * taking it away. Two tests below exist to hold the line on what it is *not* —
 * there is no control for choosing which credential a project uses and none for
 * choosing a model, and a Node must not be able to summon either by reporting
 * something.
 */

const NODE = 'node-under-test';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface World {
  credentials: unknown[];
  capabilities: unknown;
  online?: boolean;
  device?: unknown;
}

async function mock(page: Page, world: World) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
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
      return json(route, { device: world.device ?? null });
    }
    if (path === `/api/v1/nodes/${NODE}`) {
      return json(route, {
        node: {
          node_id: NODE,
          display_name: 'Test Node',
          connection_state: world.online === false ? 'offline' : 'online',
          last_seen_at: new Date().toISOString(),
          software_version: 'v0.1.0-alpha.24',
          protocol_version: 1,
          identity_generation: 1,
          fingerprint: 'a'.repeat(64),
          capabilities: {},
          provider_state: 'authorized',
          draining: false,
        },
        projects: [],
        current_node_version: 'v0.1.0-alpha.24',
        current_node_release: null,
        update_operation: null,
        provider_capabilities: world.capabilities,
        credentials: world.credentials,
      });
    }
    if (path.startsWith('/api/v1/nodes')) return json(route, { nodes: [] });
    return json(route, {});
  });
}

const AVAILABLE = {
  state: 'reported',
  status: 'ok',
  schema_version: 1,
  runtime_release: 'v0.1.0-alpha.24',
  providers: [
    {
      id: 'openai-codex',
      display_name: 'OpenAI Codex',
      auth_methods: ['device_authorization'],
      availability: 'available',
    },
  ],
  reported_at: '2026-09-09T10:00:00.000Z',
  recorded_at: '2026-09-09T10:00:05.000Z',
  stale: false,
};

function credential(overrides: Record<string, unknown> = {}) {
  return {
    credential_id: 'cred-0011aabb',
    provider_id: 'openai-codex',
    auth_method: 'device_authorization',
    label: 'Existing credential',
    state: 'authorized',
    ...overrides,
  };
}

function panel(page: Page) {
  return page.getByRole('article').filter({ hasText: 'Provider credentials' }).first();
}

test('a Node with no credentials says so, and offers to make one', async ({ page }) => {
  await mock(page, { credentials: [], capabilities: AVAILABLE });
  await page.goto(`/nodes/${NODE}`);

  await expect(panel(page).getByText(/holds no provider credentials/)).toBeVisible();
  await expect(
    panel(page).getByRole('button', { name: /Add OpenAI Codex credential/ }),
  ).toBeVisible();
});

test('two credentials for one provider are shown side by side', async ({ page }) => {
  await mock(page, {
    capabilities: AVAILABLE,
    credentials: [
      credential(),
      credential({ credential_id: 'cred-second', label: 'Second account', state: 'authorizing' }),
    ],
  });
  await page.goto(`/nodes/${NODE}`);

  await expect(panel(page).getByText('Existing credential')).toBeVisible();
  // Named twice on purpose: once in the list, once in the approval heading.
  await expect(panel(page).getByText('Second account').first()).toBeVisible();
  await expect(panel(page).getByText('Ready')).toBeVisible();
  await expect(panel(page).getByText('Waiting for approval')).toBeVisible();
  await expect(
    panel(page)
      .getByText(/Browser approval/)
      .first(),
  ).toBeVisible();
});

test('a credential waiting for approval shows the link, the code and how long is left', async ({
  page,
}) => {
  await mock(page, {
    capabilities: AVAILABLE,
    credentials: [credential({ state: 'authorizing', label: 'Second account' })],
    device: {
      verification_uri: 'https://auth.openai.com/codex/device',
      user_code: 'RCB8-M9COT',
      expires_at: Date.now() + 900_000,
    },
  });
  await page.goto(`/nodes/${NODE}`);

  await expect(panel(page).getByText('RCB8-M9COT')).toBeVisible();
  await expect(
    panel(page).getByRole('link', { name: 'https://auth.openai.com/codex/device' }),
  ).toBeVisible();
  await expect(panel(page).getByText(/left/)).toBeVisible();
  await expect(
    panel(page).getByRole('button', { name: 'Cancel this authorization' }),
  ).toBeVisible();
});

/** node-2 in production. */
test('a Node whose capabilities are unknown is not offered credential creation', async ({
  page,
}) => {
  await mock(page, { credentials: [], capabilities: { state: 'unknown' } });
  await page.goto(`/nodes/${NODE}`);

  await expect(panel(page).getByText(/has not reported/)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: /Add/ })).toHaveCount(0);
});

test('an offline Node shows its credentials but offers nothing to do to them', async ({ page }) => {
  await mock(page, {
    online: false,
    capabilities: { ...AVAILABLE, stale: true },
    credentials: [credential()],
  });
  await page.goto(`/nodes/${NODE}`);

  await expect(panel(page).getByText('Existing credential')).toBeVisible();
  await expect(panel(page).getByText(/has to be connected/)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: /Add/ })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Rename' })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Revoke' })).toHaveCount(0);
});

test('revoking asks first, and says what it will cost', async ({ page }) => {
  await mock(page, { capabilities: AVAILABLE, credentials: [credential()] });
  await page.goto(`/nodes/${NODE}`);

  await panel(page).getByRole('button', { name: 'Revoke' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Existing credential will be removed/)).toBeVisible();
  await expect(dialog.getByText(/cannot be undone/)).toBeVisible();
});

test('the panel says where credentials live', async ({ page }) => {
  await mock(page, { capabilities: AVAILABLE, credentials: [credential()] });
  await page.goto(`/nodes/${NODE}`);
  await expect(panel(page).getByText(/stored on this Node and never leave it/)).toBeVisible();
});

/**
 * The boundary of this phase, asserted rather than assumed: choosing which
 * credential a project uses and choosing a model are decisions with their own
 * consequences, and neither belongs to a list of credentials.
 */
test('there is no project assignment and no model selection here', async ({ page }) => {
  await mock(page, {
    capabilities: AVAILABLE,
    credentials: [credential(), credential({ credential_id: 'cred-second', label: 'Second' })],
  });
  await page.goto(`/nodes/${NODE}`);

  const text = (await panel(page).textContent()) ?? '';
  for (const forbidden of ['model', 'Model', 'project', 'Project', 'Assign', 'Default']) {
    expect(text, `the panel must not mention ${forbidden}`).not.toContain(forbidden);
  }
  await expect(panel(page).getByRole('combobox')).toHaveCount(0);
});
