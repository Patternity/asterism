import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * What an operator sees while a Node updates, and what they see when they come
 * back to the page.
 *
 * The reload is the point. Nothing about the operation lives in the tab: it is
 * a row in the Control Plane, so a browser that goes away and returns finds the
 * same operation at the same stage rather than an empty panel and a Node that
 * has mysteriously stopped responding.
 */

const NODE = 'node-under-test';
const TO = 'v0.1.0-alpha.22';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface Operation {
  operation_id: string;
  requested_version: string;
  previous_version: string | null;
  reported_version: string | null;
  stage: string;
  detail_state: string | null;
  percent: number;
  bytes_done?: number | null;
  bytes_total?: number | null;
  failure_code: string | null;
  failure_message: string | null;
}

/** The Control Plane, as far as this page is concerned. */
async function mock(page: Page, operation: Operation | null, notes = 'Fixes the updater.') {
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
          software_version: 'v0.1.0-alpha.21',
          protocol_version: 1,
          identity_generation: 1,
          fingerprint: 'a'.repeat(64),
          capabilities: {},
          provider_state: 'authorized',
          draining: false,
        },
        projects: [],
        current_node_version: TO,
        current_node_release: { version: TO, notes, url: 'https://example.invalid' },
        update_operation: operation,
      });
    }
    if (path.startsWith('/api/v1/nodes')) return json(route, { nodes: [] });
    return json(route, {});
  });
}

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    operation_id: 'op-1',
    requested_version: TO,
    previous_version: 'v0.1.0-alpha.21',
    reported_version: null,
    stage: 'applying',
    detail_state: 'bundle_downloading',
    percent: 34,
    bytes_done: 180_000_000,
    bytes_total: 518_000_000,
    failure_code: null,
    failure_message: null,
    ...overrides,
  };
}

test('the release notes are readable before the update is confirmed', async ({ page }) => {
  await mock(page, null, 'Finishes an update in the process that was handed it.');
  await page.goto(`/nodes/${NODE}`);

  await page.getByRole('button', { name: `Update to ${TO}` }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByText(`What is in ${TO}`).click();
  await expect(
    dialog.getByText('Finishes an update in the process that was handed it.'),
  ).toBeVisible();
});

test('a running update shows its stage and how far it has got', async ({ page }) => {
  await mock(page, operation());
  await page.goto(`/nodes/${NODE}`);

  const panel = page.getByRole('article').filter({ hasText: 'Update' }).first();
  await expect(panel.getByText(/downloading the runtime/i)).toBeVisible();
  await expect(panel.getByText('34%')).toBeVisible();
  await expect(panel.getByText(/180 MB of 518 MB/)).toBeVisible();
});

/**
 * The stage that carries the whole design: everything is installed and nothing
 * is yet known. The page must not call that done.
 */
test('waiting for the Node to come back is not shown as success', async ({ page }) => {
  await mock(
    page,
    operation({ stage: 'awaiting_reconnect', detail_state: 'complete', percent: 99 }),
  );
  await page.goto(`/nodes/${NODE}`);

  const panel = page.getByRole('article').filter({ hasText: 'Update' }).first();
  await expect(panel.getByText(/waiting for the node to restart/i)).toBeVisible();
  await expect(panel.getByText('99%')).toBeVisible();
  await expect(panel.getByText(/came back on/i)).toHaveCount(0);
});

test('a reload during an update comes back to the same operation', async ({ page }) => {
  await mock(page, operation({ percent: 61, detail_state: 'runtime_installing' }));
  await page.goto(`/nodes/${NODE}`);

  const panel = page.getByRole('article').filter({ hasText: 'Update' }).first();
  await expect(panel.getByText('61%')).toBeVisible();

  await page.reload();

  const afterReload = page.getByRole('article').filter({ hasText: 'Update' }).first();
  await expect(afterReload.getByText(/installing the runtime/i)).toBeVisible();
  await expect(afterReload.getByText('61%')).toBeVisible();
  // Named more than once in the panel, which is the point: it survived.
  await expect(afterReload.getByText(TO).first()).toBeVisible();
});

test('the result is still there after the update has ended', async ({ page }) => {
  await mock(
    page,
    operation({
      stage: 'succeeded',
      detail_state: null,
      percent: 100,
      reported_version: TO,
      bytes_done: null,
      bytes_total: null,
    }),
  );
  await page.goto(`/nodes/${NODE}`);
  await page.reload();

  const panel = page.getByRole('article').filter({ hasText: 'Update' }).first();
  await expect(panel.getByText(/came back on/i)).toBeVisible();
  await expect(panel.getByText('100%')).toBeVisible();
});

test('a reconnect on the wrong release is surfaced, not hidden', async ({ page }) => {
  await mock(
    page,
    operation({
      stage: 'failed',
      detail_state: null,
      percent: 99,
      reported_version: 'v0.1.0-alpha.21',
      failure_code: 'version_mismatch',
      failure_message: `the Node came back reporting v0.1.0-alpha.21, not ${TO}`,
    }),
  );
  await page.goto(`/nodes/${NODE}`);

  const panel = page.getByRole('article').filter({ hasText: 'Update' }).first();
  await expect(panel.getByText(/came back reporting v0\.1\.0-alpha\.21/)).toBeVisible();
  await expect(panel.getByText('version_mismatch')).toBeVisible();
});
