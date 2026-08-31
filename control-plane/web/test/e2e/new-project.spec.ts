/**
 * The new-project flow, in a browser, against the real thing.
 *
 * Everything below this test is production code: the real Control Plane serving
 * the real built console, real session and CSRF middleware, a real PostgreSQL
 * database, and a Node that authenticates over a real WebSocket with a real
 * Ed25519 signature and receives the real `project.provision` command.
 *
 * Only one thing is emulated, and only because a test cannot own it: the Node
 * answers the provisioning command instead of building a workspace and starting
 * a worker. Its answer travels the real command-result path, carrying the real
 * command id and provisioning generation — which is what the Control Plane
 * actually checks before it will call a project ready.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type AddressInfo } from 'node:net';

import { buildApp } from '../../../src/app.js';
import { hashPassword } from '../../../src/auth.js';
import { loadConfig, type Config } from '../../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../../src/db.js';
import { createLogger } from '../../../src/logger.js';
import { NodeChannel } from '../../../src/node-channel.js';
import { nodesRepo } from '../../../src/repositories.js';
import {
  LEGACY_CAPABILITIES,
  PROVISIONING_CAPABILITIES,
  TestNode,
  createNodeKeys,
} from '../../../test/support/test-node.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../dist');
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const PASSWORD = 'correct horse battery staple';

let pool: Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let channel: NodeChannel;
let origin: string;
let passwordHash: string;

test.beforeAll(async () => {
  pool = createPool(DATABASE_URL, 8);
  await migrate(pool);
  await rollbackAll(pool).catch(() => undefined);
  await migrate(pool);
  passwordHash = await hashPassword(PASSWORD);

  // Bound first so the console is served from the same origin the browser will
  // use: the API is same-origin in production, and a cross-origin harness would
  // exercise a CORS path that never runs.
  const probe = await new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
  origin = `http://127.0.0.1:${probe}`;

  const config: Config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    PUBLIC_BASE_URL: origin,
    ALLOWED_ORIGINS: origin,
    ALLOW_PLAINTEXT: 'true',
    OPERATOR_COMPATIBILITY: 'false',
    STATIC_ROOT: DIST,
    LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv);

  channel = new NodeChannel(pool, config, createLogger('fatal'));
  channel.start();
  app = await buildApp({ pool, config, log: createLogger('fatal'), channel });
  await app.listen({ port: probe, host: '127.0.0.1' });
});

const connected: TestNode[] = [];

test.afterEach(async () => {
  for (const node of connected.splice(0)) await node.close();
  // The rows too: an offline Node still appears in the picker, and the next
  // test's "nothing eligible" page would find this one.
  await pool.query('DELETE FROM projects');
  await pool.query('DELETE FROM nodes');
});

test.afterAll(async () => {
  await app?.close();
  await channel?.stop();
  await pool?.end();
});

/** A unique world per test, so nothing observes another test's leftovers. */
async function world(role: string) {
  const suffix = randomUUID().slice(0, 8);
  const email = `owner-${suffix}@example.com`;
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [userId, email, `Owner ${suffix}`, passwordHash],
  );
  await pool.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)`, [
    'org_bootstrap',
    userId,
    role,
  ]);
  return { suffix, email, userId };
}

async function connectNode(suffix: string, capabilities: Record<string, unknown>) {
  const keys = createNodeKeys();
  const nodeId = `node-${suffix}`;
  await nodesRepo.create(pool, {
    nodeId,
    displayName: `Builder ${suffix}`,
    publicKey: keys.publicKeyBase64,
    fingerprint: keys.fingerprint,
    organizationId: 'org_bootstrap',
  });
  const node = await TestNode.connect(
    origin.replace('http://', 'ws://'),
    nodeId,
    keys,
    capabilities,
  );
  await node.waitForCommand('capabilities.get');
  // The routes read the stored snapshot, so wait for it rather than for a timer.
  await expect
    .poll(async () => {
      const stored = await pool.query<{ capabilities: Record<string, unknown> }>(
        'SELECT capabilities FROM nodes WHERE node_id = $1',
        [nodeId],
      );
      return Boolean(stored.rows[0]?.capabilities && 'projects' in stored.rows[0].capabilities);
    })
    .toBe(capabilities === PROVISIONING_CAPABILITIES);
  connected.push(node);
  return node;
}

/** Sign in through the real form so the session and CSRF cookies are genuine. */
async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto(`${origin}/login`);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Answer the provisioning command the way a Node reports a finished build. */
function reportProvisioned(
  node: TestNode,
  commandId: string,
  projectId: string,
  generation: number,
) {
  node.completeCommand(commandId, {
    outcome: 'provisioned',
    event_version: 1,
    project_id: projectId,
    provisioning_generation: generation,
    runtime_kind: 'hermes_home',
    workspace_mode: 'empty',
  });
}

function reportFailed(
  node: TestNode,
  commandId: string,
  projectId: string,
  generation: number,
  failure: string,
  retryable: boolean,
) {
  node.completeCommand(commandId, {
    outcome: 'failed',
    event_version: 1,
    project_id: projectId,
    provisioning_generation: generation,
    failure,
    retryable,
    message: 'the project could not be prepared',
  });
}

test.describe('who may start a project', () => {
  test('a role the server accepts is offered the action', async ({ page }) => {
    const { suffix, email } = await world('owner');
    await connectNode(suffix, PROVISIONING_CAPABILITIES);
    await signIn(page, email);
    await page.goto(`${origin}/projects`);
    await expect(page.getByRole('link', { name: /new project/i })).toBeVisible();
  });

  test('a role the server refuses is not offered a form, and cannot use one', async ({ page }) => {
    const { email } = await world('developer');
    await signIn(page, email);
    await page.goto(`${origin}/projects`);
    await expect(page.getByRole('link', { name: /new project/i })).toHaveCount(0);

    // Reaching the route directly changes nothing: the server is what refuses.
    await page.goto(`${origin}/projects/new`);
    const submit = page.getByRole('button', { name: /create project/i });
    if (await submit.count()) {
      await page.getByLabel(/project name/i).fill('Should not exist');
      await page.getByLabel(/identifier/i).fill('should-not-exist');
      await submit.click();
      // Refused by the server, which is the only thing that decides this.
      await expect(page.getByRole('alert')).toBeVisible();
    }
    const projects = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [
      'should-not-exist',
    ]);
    expect(projects.rowCount).toBe(0);
  });
});

test.describe('choosing where a project runs', () => {
  test('a Node that never advertises provisioning cannot be chosen', async ({ page }) => {
    const { suffix, email } = await world('owner');
    await connectNode(suffix, LEGACY_CAPABILITIES);
    await signIn(page, email);
    await page.goto(`${origin}/projects/new`);
    // Nothing eligible: the page says so instead of offering a dead form.
    await expect(page.getByText(/no connected node can host/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /create project/i })).toHaveCount(0);
  });
});

test.describe('creating an empty project', () => {
  test('stays unready until the Node reports a healthy worker', async ({ page }) => {
    const { suffix, email } = await world('owner');
    const node = await connectNode(suffix, PROVISIONING_CAPABILITIES);
    await signIn(page, email);
    await page.goto(`${origin}/projects/new`);

    const slug = `acceptance-${suffix}`;
    await page.getByLabel(/project name/i).fill('Acceptance project');
    await page.getByLabel(/identifier/i).fill(slug);
    await page.getByLabel(/^node$/i).selectOption(`node-${suffix}`);
    await page.getByRole('button', { name: /create project/i }).click();

    // Queued, and with no way to send a turn.
    await expect(page.getByText(/queued for its node|is preparing the workspace/i)).toBeVisible();
    await expect(page.getByPlaceholder(/describe the task/i)).toHaveCount(0);

    const command = await node.waitForCommand('project.provision');
    expect(command.payload.workspace_mode).toBe('empty');
    expect(JSON.stringify(command.payload)).not.toContain('repository_url');

    // A reload while it is still provisioning must restore the same project
    // from the server, not create a second one.
    await page.reload();
    await expect(page.getByText(/queued for its node|is preparing the workspace/i)).toBeVisible();
    expect((await pool.query('SELECT 1 FROM projects')).rowCount).toBe(1);
    expect(
      (await pool.query(`SELECT 1 FROM remote_commands WHERE command_type = 'project.provision'`))
        .rowCount,
    ).toBe(1);

    reportProvisioned(node, command.command_id, String(command.payload.project_id), 1);

    // The composer appears only now, because only now did the server say ready.
    await expect(page.getByPlaceholder(/describe the task/i)).toBeVisible({ timeout: 15_000 });
  });

  test('a repository the operator changed their mind about is not sent', async ({ page }) => {
    const { suffix, email } = await world('owner');
    const node = await connectNode(suffix, PROVISIONING_CAPABILITIES);
    await signIn(page, email);
    await page.goto(`${origin}/projects/new`);

    await page.getByLabel(/project name/i).fill('Switched back');
    await page.getByLabel(/identifier/i).fill(`switched-${suffix}`);
    await page.getByLabel(/^node$/i).selectOption(`node-${suffix}`);
    await page.getByRole('radio', { name: /clone an existing/i }).check();
    await page
      .getByLabel(/repository address/i)
      .fill('https://example.test/organization/repository.git');
    await page.getByLabel(/branch/i).fill('main');
    await page.getByRole('radio', { name: /create an empty/i }).check();
    await page.getByRole('button', { name: /create project/i }).click();

    const command = await node.waitForCommand('project.provision');
    // Hidden is not the same as removed: a payload built from the whole form
    // would still carry the repository, and the Node would clone it.
    expect(JSON.stringify(command.payload)).not.toContain('example.test');
    expect(command.payload.workspace_mode).toBe('empty');
  });

  test('a clone carries its repository and branch', async ({ page }) => {
    const { suffix, email } = await world('owner');
    const node = await connectNode(suffix, PROVISIONING_CAPABILITIES);
    await signIn(page, email);
    await page.goto(`${origin}/projects/new`);

    await page.getByLabel(/project name/i).fill('Cloned project');
    await page.getByLabel(/identifier/i).fill(`cloned-${suffix}`);
    await page.getByLabel(/^node$/i).selectOption(`node-${suffix}`);
    await page.getByRole('radio', { name: /clone an existing/i }).check();
    await page
      .getByLabel(/repository address/i)
      .fill('https://example.test/organization/repository.git');
    await page.getByLabel(/branch/i).fill('release');
    await page.getByRole('button', { name: /create project/i }).click();

    const command = await node.waitForCommand('project.provision');
    expect(command.payload.repository_url).toBe('https://example.test/organization/repository.git');
    expect(command.payload.branch).toBe('release');
  });
});

test.describe('when provisioning fails', () => {
  test('offers one retry, and an older attempt cannot make it ready', async ({ page }) => {
    const { suffix, email } = await world('owner');
    const node = await connectNode(suffix, PROVISIONING_CAPABILITIES);
    await signIn(page, email);
    await page.goto(`${origin}/projects/new`);

    await page.getByLabel(/project name/i).fill('Retryable project');
    await page.getByLabel(/identifier/i).fill(`retry-${suffix}`);
    await page.getByLabel(/^node$/i).selectOption(`node-${suffix}`);
    await page.getByRole('button', { name: /create project/i }).click();

    const first = await node.waitForCommand('project.provision');
    reportFailed(
      node,
      first.command_id,
      String(first.payload.project_id),
      1,
      'repository_clone_failed',
      true,
    );

    const retry = page.getByRole('button', { name: /retry provisioning/i });
    await expect(retry).toBeVisible({ timeout: 15_000 });

    // Two activations, one attempt: a second generation for one decision would
    // leave the first attempt's result able to land on the wrong one.
    await retry.click();
    await retry.click({ force: true }).catch(() => undefined);
    const second = await node.waitForCommand('project.provision', 15_000, 1);
    expect(second.command_id).not.toBe(first.command_id);
    await expect
      .poll(async () => {
        const rows = await pool.query(
          `SELECT count(*)::int AS n FROM remote_commands WHERE command_type = 'project.provision'`,
        );
        return rows.rows[0].n as number;
      })
      .toBe(2);

    // The first attempt now answers, late and stale. It must not promote the
    // second attempt: the project claims a worker nobody started.
    reportProvisioned(node, first.command_id, String(first.payload.project_id), 1);
    await page.waitForTimeout(1_000);
    await expect(page.getByPlaceholder(/describe the task/i)).toHaveCount(0);

    reportProvisioned(node, second.command_id, String(second.payload.project_id), 2);
    await expect(page.getByPlaceholder(/describe the task/i)).toBeVisible({ timeout: 15_000 });
  });

  test('a failure retrying cannot fix offers no retry', async ({ page }) => {
    const { suffix, email } = await world('owner');
    const node = await connectNode(suffix, PROVISIONING_CAPABILITIES);
    await signIn(page, email);
    await page.goto(`${origin}/projects/new`);

    await page.getByLabel(/project name/i).fill('Hopeless project');
    await page.getByLabel(/identifier/i).fill(`hopeless-${suffix}`);
    await page.getByLabel(/^node$/i).selectOption(`node-${suffix}`);
    await page.getByRole('button', { name: /create project/i }).click();

    const command = await node.waitForCommand('project.provision');
    reportFailed(
      node,
      command.command_id,
      String(command.payload.project_id),
      1,
      'node_capability_unavailable',
      false,
    );

    await expect(page.getByText(/trying again will not change this/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: /retry provisioning/i })).toHaveCount(0);
  });

  test('an unknown failure code is explained without repeating it', async ({ page }) => {
    const { suffix, email } = await world('owner');
    const node = await connectNode(suffix, PROVISIONING_CAPABILITIES);
    await signIn(page, email);
    await page.goto(`${origin}/projects/new`);

    await page.getByLabel(/project name/i).fill('Unknown failure');
    await page.getByLabel(/identifier/i).fill(`unknown-${suffix}`);
    await page.getByLabel(/^node$/i).selectOption(`node-${suffix}`);
    await page.getByRole('button', { name: /create project/i }).click();

    const command = await node.waitForCommand('project.provision');
    reportFailed(
      node,
      command.command_id,
      String(command.payload.project_id),
      1,
      'invented_later',
      false,
    );

    await expect(page.getByText(/could not be prepared/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/invented_later/)).toHaveCount(0);
  });
});

test.describe('what the browser is allowed to see', () => {
  test('no host path, worker port, key or profile identity reaches the page', async ({ page }) => {
    const { suffix, email } = await world('owner');
    const node = await connectNode(suffix, PROVISIONING_CAPABILITIES);

    // Every API response the page receives, recorded as it arrives.
    const bodies: string[] = [];
    page.on('response', async (response) => {
      if (!response.url().includes('/api/v1/')) return;
      await response.text().then(
        (text) => bodies.push(text),
        () => undefined,
      );
    });

    await signIn(page, email);
    await page.goto(`${origin}/projects/new`);
    await page.getByLabel(/project name/i).fill('Leak check');
    await page.getByLabel(/identifier/i).fill(`leak-${suffix}`);
    await page.getByLabel(/^node$/i).selectOption(`node-${suffix}`);
    await page.getByRole('button', { name: /create project/i }).click();

    const command = await node.waitForCommand('project.provision');
    reportProvisioned(node, command.command_id, String(command.payload.project_id), 1);
    await expect(page.getByPlaceholder(/describe the task/i)).toBeVisible({ timeout: 15_000 });

    const dom = (await page.content()) + bodies.join('\n');
    for (const secret of [
      'workspace_path',
      'hermes_profile',
      'hermes_api_key_ref',
      'runtime_endpoint',
      '/var/lib/asterism',
      'API_SERVER_KEY',
      'auth.json',
    ]) {
      expect(dom, `browser-visible data must not contain ${secret}`).not.toContain(secret);
    }
    // A settled project stops being asked about.
    const before = bodies.length;
    await page.waitForTimeout(3_000);
    expect(bodies.length - before).toBeLessThanOrEqual(1);
  });
});
