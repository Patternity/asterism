import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The project model panel.
 *
 * The page offers exactly what the Control Plane says the project's Node
 * reported, and nothing when it says that report cannot be trusted. No model
 * and no provider name is written in this console; every name in these tests is
 * invented here and arrives through the API, which is what proves it.
 */

const PROJECT = 'prj_under_test';
const NODE = 'node-under-test';

const OFFERED = [
  { id: 'quokka-9.2:fast', display_name: 'Quokka 9.2 Fast' },
  { id: 'quokka-9.2', display_name: 'Quokka 9.2' },
];

const NODE_RECORD = {
  node_id: NODE,
  display_name: 'Test Node',
  connection_state: 'online',
  last_seen_at: new Date().toISOString(),
  software_version: 'v0.1.0-alpha.32',
  protocol_version: 1,
  identity_generation: 1,
  fingerprint: 'a'.repeat(64),
  capabilities: {},
  provider_state: 'authorized',
  draining: false,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface World {
  model: Record<string, unknown>;
  /** What the project detail returns once a change has been asked for. */
  modelAfterChange?: Record<string, unknown>;
  supportsModels?: boolean;
  /** The status and body a change request is answered with. */
  changeReply?: { status: number; body: unknown };
}

async function mock(page: Page, world: World) {
  let changed = false;
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'PUT' && path === `/api/v1/projects/${PROJECT}/model`) {
      requests.push(JSON.parse(route.request().postData() ?? '{}'));
      changed = true;
      const reply = world.changeReply ?? { status: 202, body: {} };
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
    if (path === `/api/v1/projects/${PROJECT}`) {
      return json(route, {
        project: {
          project_id: PROJECT,
          name: 'Project under test',
          slug: 'under-test',
          node_id: NODE,
          enabled: true,
          available: true,
          workspace: { mode: 'empty', repository_url: null, branch: null },
          provisioning: {
            state: 'ready',
            generation: 1,
            failure: null,
            failure_message: null,
            retryable: false,
          },
          can_run: true,
          node_online: true,
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
            supports_project_models: world.supportsModels !== false,
          },
          provider_state: 'authorized',
          credential: {
            mode: 'isolated',
            current: {
              credential_id: 'cred-work',
              label: 'Work account',
              provider_id: 'acme-llm',
              state: 'authorized',
            },
            assignment: { state: 'applied', requested: null, failure: null },
            run_block: null,
          },
          model: changed && world.modelAfterChange ? world.modelAfterChange : world.model,
        },
        node: NODE_RECORD,
        active_run: null,
        recent_runs: [],
      });
    }
    if (path === `/api/v1/nodes/${NODE}`) {
      // The credential panel beside this one asks for the Node.
      return json(route, {
        node: NODE_RECORD,
        projects: [],
        credentials: [],
        provider_capabilities: {
          state: 'reported',
          status: 'ok',
          schema_version: 2,
          runtime_release: 'v0.1.0-alpha.32',
          providers: [
            {
              id: 'acme-llm',
              display_name: 'ACME',
              auth_methods: ['device_authorization'],
              availability: 'available',
              models: OFFERED,
            },
          ],
          reported_at: new Date().toISOString(),
          recorded_at: new Date().toISOString(),
          stale: false,
        },
      });
    }
    if (path.startsWith('/api/v1/nodes')) return json(route, { nodes: [] });
    if (path.endsWith('/events')) return json(route, { events: [] });
    return json(route, {});
  });
  return requests;
}

function panel(page: Page) {
  // By its heading: other panels on this page mention the word.
  return page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Model', exact: true }) });
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    selected: null,
    requested: null,
    state: 'legacy_default',
    failure: null,
    provider_id: 'acme-llm',
    available: OFFERED,
    blocked: null,
    run_block: null,
    ...overrides,
  };
}

test('offers exactly the models the Node reported, and says what a project runs now', async ({
  page,
}) => {
  await mock(page, { model: model() });
  await page.goto(`/projects/${PROJECT}`);

  await expect(panel(page).getByText(/has never been given a model/)).toBeVisible();
  const select = panel(page).getByLabel('Model');
  await expect(select).toBeVisible();
  await expect(select.locator('option')).toHaveText(['Quokka 9.2 Fast', 'Quokka 9.2']);
  // The Node's own names, not identifiers this console invented.
  await expect(panel(page).getByText(/Whether the account behind its credential/)).toBeVisible();
});

test('sends the chosen identifier and shows what the Node confirmed', async ({ page }) => {
  const requests = await mock(page, {
    model: model(),
    modelAfterChange: model({
      selected: null,
      requested: 'quokka-9.2',
      state: 'pending',
      run_block: {
        error: 'model_selection_pending',
        message: 'This project’s model is being changed.',
      },
    }),
  });
  await page.goto(`/projects/${PROJECT}`);

  await panel(page).getByLabel('Model').selectOption('quokka-9.2');
  await panel(page).getByRole('button', { name: 'Use this model' }).click();

  await expect(panel(page).getByText(/Switching to Quokka 9.2\./)).toBeVisible();
  expect(requests).toEqual([{ model: 'quokka-9.2' }]);
});

/** A refusal is shown as the backend's own words, never swallowed. */
test('shows a typed rejection instead of claiming success', async ({ page }) => {
  await mock(page, {
    model: model(),
    changeReply: {
      status: 409,
      body: {
        error: 'model_not_reported',
        message: 'This project’s Node does not report that model for that credential’s provider.',
      },
    },
  });
  await page.goto(`/projects/${PROJECT}`);

  await panel(page).getByLabel('Model').selectOption('quokka-9.2');
  await panel(page).getByRole('button', { name: 'Use this model' }).click();

  await expect(panel(page).getByRole('alert')).toContainText('does not report that model');
  await expect(panel(page).getByText(/has never been given a model/)).toBeVisible();
});

test('offers nothing when the Node’s report cannot be trusted, and says why', async ({ page }) => {
  await mock(page, {
    model: model({
      available: [],
      blocked: {
        error: 'capabilities_stale',
        message: 'This project’s Node has not confirmed its runtime since it reconnected.',
      },
    }),
  });
  await page.goto(`/projects/${PROJECT}`);

  await expect(panel(page).getByText(/has not confirmed its runtime/)).toBeVisible();
  await expect(panel(page).getByLabel('Model')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Use this model' })).toHaveCount(0);
});

test('says so when the Node’s build cannot be given a model', async ({ page }) => {
  await mock(page, { model: model(), supportsModels: false });
  await page.goto(`/projects/${PROJECT}`);

  await expect(panel(page).getByText(/runs a build that cannot be given a model/)).toBeVisible();
  await expect(panel(page).getByLabel('Model')).toHaveCount(0);
});

test('explains a change the Node could not confirm, and what runs are waiting for', async ({
  page,
}) => {
  await mock(page, {
    model: model({
      selected: 'quokka-9.2',
      requested: null,
      state: 'inconsistent',
      failure: 'worker_not_restarted',
      run_block: {
        error: 'model_selection_inconsistent',
        message: 'The Node could not confirm which model this project’s runtime is using.',
      },
    }),
  });
  await page.goto(`/projects/${PROJECT}`);

  await expect(panel(page).getByText(/did not restart/)).toBeVisible();
  await expect(
    panel(page)
      .getByText(/could not confirm which model/)
      .first(),
  ).toBeVisible();
});
