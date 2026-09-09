import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The providers panel, in each of the four states a Node can put it in.
 *
 * The panel is read-only by design: this phase says what a runtime can reach and
 * offers nothing to press. Two of these tests exist to hold that line — a Node
 * must not be able to summon a credential control by reporting a provider.
 */

const NODE = 'node-under-test';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mock(page: Page, capabilities: unknown) {
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
    if (path === `/api/v1/nodes/${NODE}`) {
      return json(route, {
        node: {
          node_id: NODE,
          display_name: 'Test Node',
          connection_state: 'online',
          last_seen_at: new Date().toISOString(),
          software_version: 'v0.1.0-alpha.23',
          protocol_version: 1,
          identity_generation: 1,
          fingerprint: 'a'.repeat(64),
          capabilities: {},
          provider_state: 'authorized',
          draining: false,
        },
        projects: [],
        current_node_version: 'v0.1.0-alpha.23',
        current_node_release: null,
        update_operation: null,
        provider_capabilities: capabilities,
      });
    }
    if (path.startsWith('/api/v1/nodes')) return json(route, { nodes: [] });
    return json(route, {});
  });
}

function reported(overrides: Record<string, unknown> = {}) {
  return {
    state: 'reported',
    status: 'ok',
    schema_version: 1,
    runtime_release: 'v0.1.0-alpha.23',
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
    ...overrides,
  };
}

function panel(page: Page) {
  return page.getByRole('article').filter({ hasText: 'Providers' }).first();
}

test('a reported provider is shown with how it is authenticated', async ({ page }) => {
  await mock(page, reported());
  await page.goto(`/nodes/${NODE}`);

  await expect(panel(page).getByText('OpenAI Codex')).toBeVisible();
  await expect(panel(page).getByText(/Available/)).toBeVisible();
  await expect(panel(page).getByText(/Browser approval/)).toBeVisible();
  await expect(panel(page).getByText(/Reported/)).toBeVisible();
});

test('a provider the runtime cannot reach says so, and why', async ({ page }) => {
  await mock(
    page,
    reported({
      providers: [
        {
          id: 'openai-codex',
          display_name: 'OpenAI Codex',
          auth_methods: ['device_authorization'],
          availability: 'unavailable',
          unavailable_reason: 'runtime_missing',
        },
      ],
    }),
  );
  await page.goto(`/nodes/${NODE}`);
  await expect(
    panel(page).getByText(/Unavailable — the runtime it needs is not installed/),
  ).toBeVisible();
});

/** node-2 in production: a release older than the contract. */
test('a Node that never reported is shown as unknown, not as supporting nothing', async ({
  page,
}) => {
  await mock(page, { state: 'unknown' });
  await page.goto(`/nodes/${NODE}`);

  await expect(panel(page).getByText(/has not reported/)).toBeVisible();
  await expect(panel(page).getByText('OpenAI Codex')).toHaveCount(0);
});

test('an offline Node shows its last snapshot as the past', async ({ page }) => {
  await mock(page, reported({ stale: true }));
  await page.goto(`/nodes/${NODE}`);

  await expect(panel(page).getByText(/offline/i)).toBeVisible();
  await expect(panel(page).getByText(/last thing it reported/i)).toBeVisible();
  // Still shown, because stale is not unknown.
  await expect(panel(page).getByText('OpenAI Codex')).toBeVisible();
});

/**
 * The failure that must stay safe: a shape this console cannot read exposes
 * nothing and does not break the page around it.
 */
test('a schema this console cannot read shows no providers and does not break the page', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  await mock(
    page,
    reported({
      status: 'unsupported_schema',
      schema_version: 99,
      providers: null,
      runtime_release: null,
    }),
  );
  await page.goto(`/nodes/${NODE}`);

  await expect(panel(page).getByText(/cannot read/)).toBeVisible();
  await expect(panel(page).getByText('99')).toBeVisible();
  await expect(panel(page).getByText('OpenAI Codex')).toHaveCount(0);
  // The rest of the page is still there.
  await expect(page.getByText('Test Node')).toBeVisible();
  expect(errors).toEqual([]);
});

/**
 * Discovery is not authorization. A Node reporting several providers, including
 * ones that name an API key, must produce no control of any kind in this panel.
 */
test('reporting providers produces nothing to press', async ({ page }) => {
  await mock(
    page,
    reported({
      providers: [
        {
          id: 'openai-codex',
          display_name: 'OpenAI Codex',
          auth_methods: ['device_authorization', 'api_key'],
          availability: 'available',
        },
        {
          id: 'acme-llm',
          display_name: 'Acme LLM',
          auth_methods: ['api_key'],
          availability: 'available',
        },
      ],
    }),
  );
  await page.goto(`/nodes/${NODE}`);

  // Both are shown, including the one this console has never heard of.
  await expect(panel(page).getByText('Acme LLM')).toBeVisible();
  // Named by both providers here, which is why this takes the first.
  await expect(
    panel(page)
      .getByText(/API key/)
      .first(),
  ).toBeVisible();
  // And neither brings a control with it.
  await expect(panel(page).getByRole('button')).toHaveCount(0);
  await expect(panel(page).getByRole('link')).toHaveCount(0);
  await expect(panel(page).getByRole('textbox')).toHaveCount(0);
});
