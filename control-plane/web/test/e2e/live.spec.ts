import { expect, test, type Page } from '@playwright/test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const baseUrl = process.env.LIVE_BASE_URL;
const ownerPassword = process.env.LIVE_OWNER_PASSWORD;
const ownerEmail = process.env.LIVE_OWNER_EMAIL ?? 'phase-h-owner@example.invalid';
const disruptionContainer = process.env.LIVE_HERMES_CONTAINER;
const interruptedRunId = process.env.LIVE_INTERRUPTED_RUN_ID;
const replayRunId = process.env.LIVE_REPLAY_RUN_ID;
const replayExpectedText = process.env.LIVE_REPLAY_EXPECTED_TEXT;
const sessionState = process.env.LIVE_SESSION_STATE;
const approvalWorkspace = path.resolve(process.cwd(), '../../fixtures/test-project');
const execFileAsync = promisify(execFile);

function verdict(name: string, evidence: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ verdict: name, ...evidence }));
}

async function fixtureExists(relativePath: string) {
  try {
    await access(path.join(approvalWorkspace, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function prepareFixture(relativePath: string) {
  const target = path.join(approvalWorkspace, relativePath);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'marker'), 'Disposable Phase H acceptance fixture.\n', {
    mode: 0o600,
  });
}

test.describe('live browser to Hermes acceptance', () => {
  test.skip(!baseUrl || !ownerPassword, 'requires an explicitly provisioned live Phase H stack');
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  async function login(page: Page) {
    await page.goto(`${baseUrl}/login`);
    await page.getByLabel('Email address').fill(ownerEmail);
    await page.getByLabel('Password').fill(ownerPassword!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  }

  async function createRun(page: Page, projectName: string, prompt: string) {
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByRole('link', { name: projectName }).click();
    await expect(page.getByText('Project is idle.')).toBeVisible();
    await page.getByLabel('Task').fill(prompt);
    await page.getByRole('button', { name: 'Create run' }).click();
    await expect(page.getByRole('heading', { name: /^Run / })).toBeVisible();
  }

  async function openIdleProject(page: Page, projectName: string, prompt: string) {
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByRole('link', { name: projectName }).click();
    await expect(page.getByText('Project is idle.')).toBeVisible();
    await page.getByLabel('Task').fill(prompt);
  }

  async function runStatus(page: Page) {
    return (
      await page
        .locator('article.panel')
        .filter({ has: page.getByRole('heading', { name: 'Status' }) })
        .locator('.badge')
        .textContent()
    )?.trim();
  }

  async function productFetch(
    page: Page,
    pathName: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    return page.evaluate(
      async ({ pathName, method, body }) => {
        const csrf = document.cookie
          .split('; ')
          .find((cookie) => cookie.startsWith('asterism_csrf='))
          ?.split('=')[1];
        const response = await fetch(pathName, {
          method: method ?? 'GET',
          credentials: 'include',
          headers: {
            ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
      },
      { pathName, method: init.method, body: init.body },
    );
  }

  test('logs in, sees the live inventory, streams a real run, and replays after reload', async ({
    page,
  }) => {
    await login(page);
    const onlineMetric = page.locator('.metric').filter({ hasText: 'Online Nodes' });
    await expect(onlineMetric.getByText('1', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Nodes' }).click();
    await expect(page.getByRole('heading', { name: 'xell' })).toBeVisible();

    await createRun(
      page,
      'Phase A Live',
      'Read the first line of README.md and reply with only that line.',
    );
    await expect(page.locator('.output pre')).not.toBeEmpty({ timeout: 150_000 });
    const outputBeforeReload = await page.locator('.output pre').textContent();
    await page.reload();
    await expect(page.locator('.output pre')).toContainText(outputBeforeReload!.trim(), {
      timeout: 30_000,
    });
    await expect(page.getByText('completed', { exact: true })).toBeVisible({ timeout: 150_000 });
  });

  test('denies a real approval after reload', async ({ page }) => {
    const target = '.phase-h-acceptance/deny-target';
    await prepareFixture(target);
    expect(await fixtureExists(`${target}/marker`)).toBe(true);
    await login(page);
    await createRun(
      page,
      'Phase A Live',
      `Use the terminal exactly once to run \`rm -rf ${target}\` from the current workspace. Do not use any alternative command or tool. The target is a disposable acceptance fixture.`,
    );
    await expect(page.getByRole('heading', { name: 'Approval required' })).toBeVisible({
      timeout: 150_000,
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Approval required' })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page.getByText('completed', { exact: true })).toBeVisible({ timeout: 150_000 });
    expect(await fixtureExists(`${target}/marker`)).toBe(true);
    const runId = new URL(page.url()).pathname.split('/').pop()!;
    const history = await productFetch(page, `/api/v1/runs/${runId}/events?since_seq=0&limit=1000`);
    const events = (history.body as { events: Array<{ seq: number; event_type: string }> }).events;
    const approval = events.find((event) => event.event_type === 'approval.request');
    expect(Number(approval?.seq)).toBeGreaterThan(0);
    expect(events.some((event) => event.event_type === 'asterism.approval.decision')).toBe(true);
    const duplicate = await productFetch(page, `/api/v1/runs/${runId}/approval`, {
      method: 'POST',
      body: { choice: 'once' },
    });
    expect(duplicate.status).toBe(409);
    verdict('approval_request_observed', { approval_id: Number(approval!.seq) });
    verdict('approval_denied_not_executed', { duplicate_resolution_status: duplicate.status });
  });

  test('approves a real approval after the event stream disconnects', async ({ page, context }) => {
    const target = '.phase-h-acceptance/approve-target';
    await prepareFixture(target);
    expect(await fixtureExists(`${target}/marker`)).toBe(true);
    await login(page);
    await createRun(
      page,
      'Phase A Live',
      `Use the terminal exactly once to run \`rm -rf ${target}\` from the current workspace. Do not use any alternative command or tool. The target is a disposable acceptance fixture.`,
    );
    await expect(page.getByRole('heading', { name: 'Approval required' })).toBeVisible({
      timeout: 150_000,
    });
    const runUrl = page.url();
    await page.close();
    const reconnected = await context.newPage();
    await reconnected.goto(runUrl);
    await expect(reconnected.getByRole('heading', { name: 'Approval required' })).toBeVisible({
      timeout: 30_000,
    });
    await reconnected.getByRole('button', { name: /Approve once/i }).click();
    await expect(reconnected.getByText('completed', { exact: true })).toBeVisible({
      timeout: 150_000,
    });
    expect(await fixtureExists(target)).toBe(false);
    await reconnected.reload();
    await expect(reconnected.getByText('completed', { exact: true })).toBeVisible();
    verdict('approval_approved_executed_once');
  });

  test('runs two different projects concurrently', async ({ browser }) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    await login(first);
    const second = await context.newPage();
    await second.goto(`${baseUrl}/`);
    await expect(second.getByRole('heading', { name: 'Overview' })).toBeVisible();

    await Promise.all([
      createRun(first, 'Phase A Live', 'Reply with exactly: PHASE_A_CONCURRENT_OK'),
      createRun(second, 'Phase G Live', 'Reply with exactly: PHASE_G_CONCURRENT_OK'),
    ]);
    await Promise.all([
      expect(first.locator('.output pre')).toContainText('PHASE_A_CONCURRENT_OK', {
        timeout: 150_000,
      }),
      expect(second.locator('.output pre')).toContainText('PHASE_G_CONCURRENT_OK', {
        timeout: 150_000,
      }),
    ]);
    await context.close();
  });

  test('enforces project single-flight and cancels the active run', async ({ page, context }) => {
    await login(page);
    const contender = await context.newPage();
    await contender.goto(`${baseUrl}/`);
    await expect(contender.getByRole('heading', { name: 'Overview' })).toBeVisible();

    await Promise.all([
      openIdleProject(
        page,
        'Phase G Live',
        'Use the terminal exactly once to run `sleep 60`. After it finishes, reply exactly LONG_RUN_ONE.',
      ),
      openIdleProject(
        contender,
        'Phase G Live',
        'Use the terminal exactly once to run `sleep 60`. After it finishes, reply exactly LONG_RUN_TWO.',
      ),
    ]);
    await Promise.all([
      page.getByRole('button', { name: 'Create run' }).click(),
      contender.getByRole('button', { name: 'Create run' }).click(),
    ]);
    await Promise.all([
      expect(page.getByRole('heading', { name: /^Run / })).toBeVisible(),
      expect(contender.getByRole('heading', { name: /^Run / })).toBeVisible(),
    ]);

    await expect
      .poll(async () => [await runStatus(page), await runStatus(contender)].sort().join(','), {
        timeout: 30_000,
      })
      .toBe('failed,running');

    const active = (await runStatus(page)) === 'running' ? page : contender;
    await active.getByRole('button', { name: 'Cancel run' }).click();
    await active.getByRole('alertdialog').getByRole('button', { name: 'Cancel run' }).click();
    await expect(active.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 30_000 });
    const cancelledRunId = new URL(active.url()).pathname.split('/').pop()!;
    const repeated = await productFetch(active, `/api/v1/runs/${cancelledRunId}/cancel`, {
      method: 'POST',
    });
    expect(repeated.status).toBe(202);
    await active.reload();
    await expect(active.getByText('cancelled', { exact: true })).toBeVisible();
    await active.getByRole('link', { name: 'Projects' }).click();
    await active.getByRole('link', { name: 'Phase G Live' }).click();
    await expect(active.getByText('Project is idle.')).toBeVisible({ timeout: 30_000 });
    await active.getByLabel('Task').fill('Reply with exactly: SINGLE_FLIGHT_RELEASED');
    await active.getByRole('button', { name: 'Create run' }).click();
    await expect(active.locator('.output pre')).toContainText('SINGLE_FLIGHT_RELEASED', {
      timeout: 60_000,
    });
    verdict('cancellation_confirmed', { repeated_status: repeated.status });
    verdict('single_flight_released');
  });

  test('creates a linked retry from a real interrupted run', async ({ page }) => {
    test.skip(
      !disruptionContainer && !interruptedRunId,
      'requires an explicitly disposable Hermes container or interrupted run',
    );
    await login(page);
    if (interruptedRunId) {
      await page.goto(`${baseUrl}/runs/${interruptedRunId}`);
      await expect(page.getByText('interrupted', { exact: true })).toBeVisible();
    } else {
      await createRun(
        page,
        'Phase G Live',
        'Use the terminal exactly once to run `sleep 20`. After it finishes, reply exactly RETRY_SOURCE_DONE.',
      );
      await expect(page.getByText('tool.started', { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
    }
    const originalUrl = page.url();
    if (!interruptedRunId) {
      const activeRetry = await productFetch(
        page,
        `/api/v1${new URL(originalUrl).pathname}/retry`,
        { method: 'POST' },
      );
      expect(activeRetry.status).toBe(409);
    }

    if (!interruptedRunId) {
      await execFileAsync('docker', ['restart', disruptionContainer!]);
      await expect(page.getByText('interrupted', { exact: true })).toBeVisible({ timeout: 60_000 });
    }

    for (let attempt = 0; disruptionContainer && attempt < 60; attempt += 1) {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        disruptionContainer!,
      ]);
      if (stdout.trim() === 'true') break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (attempt === 59) throw new Error('Hermes container did not become ready');
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page).not.toHaveURL(originalUrl);
    await expect(page.getByText('Retry of')).toBeVisible();
    const replacementUrl = page.url();
    await expect(page.locator('dl.facts').getByRole('link')).toHaveAttribute(
      'href',
      new URL(originalUrl).pathname,
    );
    await expect(page.getByText('completed', { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('.output pre')).toContainText('RETRY_SOURCE_DONE');
    const completedRetry = await productFetch(
      page,
      `/api/v1${new URL(replacementUrl).pathname}/retry`,
      { method: 'POST' },
    );
    expect(completedRetry.status).toBe(409);
    await page.goto(originalUrl);
    await expect(page.getByText('Retried as')).toBeVisible();
    await expect(page.locator('dl.facts').getByRole('link')).toHaveAttribute(
      'href',
      new URL(replacementUrl).pathname,
    );
    verdict('retry_link_verified', { completed_retry_rejection: completedRetry.status });
  });

  test('replays durable run history after a Control Plane restart', async ({ browser }) => {
    test.skip(!replayRunId || !replayExpectedText, 'requires an existing durable acceptance run');
    const context = await browser.newContext(sessionState ? { storageState: sessionState } : {});
    const page = await context.newPage();
    if (sessionState) {
      await page.goto(`${baseUrl}/`);
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    } else {
      await login(page);
    }
    await page.goto(`${baseUrl}/runs/${replayRunId}`);
    await expect(page.getByText('completed', { exact: true })).toBeVisible();
    await expect(page.locator('.output pre')).toContainText(replayExpectedText!);
    const historyBeforeReload = await page.locator('.output pre').textContent();
    await page.reload();
    await expect(page.locator('.output pre')).toContainText(historyBeforeReload!.trim());
    const history = await productFetch(
      page,
      `/api/v1/runs/${replayRunId}/events?since_seq=0&limit=1000`,
    );
    const events = (history.body as { events: Array<{ seq: number }> }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (event, index) => index === 0 || Number(event.seq) === Number(events[index - 1]!.seq) + 1,
      ),
    ).toBe(true);
    verdict('control_plane_restarted');
    verdict('browser_history_preserved');
    verdict('event_replay_gapless', { highest_seq: events.at(-1)!.seq });
    await context.close();
  });
});
