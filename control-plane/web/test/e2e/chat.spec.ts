import { expect, test, type Page, type Request, type Route } from '@playwright/test';

/**
 * Mocked browser coverage for the project chat.
 *
 * The backend is stubbed so these run anywhere: no Control Plane, no Node, no
 * Hermes, no provider. What they prove is the client contract — session
 * continuity, replay without duplication, stream lifecycle, and the controls a
 * turn exposes.
 */

const ORGANIZATION = {
  organization_id: 'org-a',
  slug: 'alpha',
  display_name: 'Alpha',
  role: 'owner',
};

const ALL_PERMISSIONS = [
  'organization.read',
  'node.read',
  'project.read',
  'run.read',
  'run.create',
  'run.manage_any',
  'run.manage_own',
];

const PROJECT_ID = 'project-alpha';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface ChatRunStub {
  run_id: string;
  status: string;
  submitted_input: string | null;
  session_id: string | null;
  retry_of_run_id?: string | null;
  created_by_user_id?: string;
}

function runRecord(stub: ChatRunStub) {
  return {
    run_id: stub.run_id,
    node_id: 'node-alpha',
    project_id: PROJECT_ID,
    node_run_id: `arun_${stub.run_id}`,
    status: stub.status,
    request_metadata: { session_id: stub.session_id },
    created_by_user_id: stub.created_by_user_id ?? 'owner',
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:01.000Z',
    finished_at: null,
    terminal_reason: null,
    error_code: null,
    error_message: null,
    retry_of_run_id: stub.retry_of_run_id ?? null,
    last_event_seq: 3,
    session_id: stub.session_id,
    submitted_input: stub.submitted_input,
  };
}

/** Server-Sent Events body. Ends the stream exactly as the Control Plane does. */
function stream(events: { seq: number; type: string; payload: unknown }[]): string {
  return (
    events
      .map(
        (event) =>
          `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({
            run_id: 'run-1',
            seq: event.seq,
            event_type: event.type,
            recorded_at: null,
            ingested_at: '2026-01-01T00:00:00Z',
            payload: event.payload,
          })}\n\n`,
      )
      .join('') + '\n'
  );
}

interface ChatMockOptions {
  /** Status given to runs the composer creates. Terminal by default so the
   *  single-flight rule does not block a multi-message test. */
  createdStatus?: string;
  permissions?: string[];
  userId?: string;
  chatRuns?: ChatRunStub[];
  sessionId?: string | null;
  streamEvents?: { seq: number; type: string; payload: unknown }[];
  archivedEvents?: { seq: number; type: string; payload: unknown }[];
}

async function mockChat(page: Page, options: ChatMockOptions = {}) {
  const userId = options.userId ?? 'owner';
  const permissions = options.permissions ?? ALL_PERMISSIONS;
  const createdRuns: Record<string, unknown>[] = [];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let sessionId = options.sessionId ?? null;
  const chatRuns = [...(options.chatRuns ?? [])];

  await page.route('**/api/v1/**', async (route: Route) => {
    const request: Request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/api/v1/auth/session') {
      return json(route, {
        user: { user_id: userId, email: `${userId}@example.com`, display_name: userId },
        active_organization: ORGANIZATION,
        permissions,
      });
    }
    if (path === '/api/v1/organizations') return json(route, { organizations: [ORGANIZATION] });
    if (path === '/api/v1/overview') return json(route, { counts: {}, recent_problem_runs: [] });

    if (path === `/api/v1/projects/${PROJECT_ID}/chat`) {
      return json(route, { session_id: sessionId, runs: chatRuns.map(runRecord) });
    }

    if (path === `/api/v1/projects/${PROJECT_ID}/runs` && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      posts.push({ path, body });
      sessionId = (body.session_id as string) ?? sessionId;
      const created = {
        run_id: `run-${chatRuns.length + 1}`,
        status: options.createdStatus ?? 'completed',
        submitted_input: body.input as string,
        session_id: sessionId,
      };
      chatRuns.push(created);
      createdRuns.push(created);
      return json(route, { run: runRecord(created) }, 201);
    }

    if (path.startsWith('/api/v1/runs/') && request.method() === 'POST') {
      posts.push({ path, body: (request.postDataJSON() as Record<string, unknown>) ?? {} });
      return json(route, { ok: true }, 202);
    }

    if (path.endsWith('/events/stream')) {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: stream(options.streamEvents ?? []),
      });
    }
    if (path.endsWith('/events')) {
      return json(route, {
        events: (options.archivedEvents ?? []).map((event) => ({
          run_id: 'run-1',
          seq: event.seq,
          event_type: event.type,
          recorded_at: null,
          ingested_at: '2026-01-01T00:00:00Z',
          payload: event.payload,
        })),
      });
    }

    if (path.startsWith(`/api/v1/projects/${PROJECT_ID}`)) {
      return json(route, {
        project: {
          project_id: PROJECT_ID,
          node_id: 'node-alpha',
          node_project_id: 'workspace',
          display_name: 'Alpha Project',
          enabled: true,
          available: true,
          first_seen_at: '2026-01-01T00:00:00.000Z',
          last_seen_at: '2026-01-01T00:00:00.000Z',
          metadata: {},
        },
        node: { node_id: 'node-alpha', display_name: 'Alpha Node' },
        active_run: null,
        recent_runs: [],
      });
    }
    return json(route, {});
  });

  return { posts };
}

const openChat = async (page: Page) => {
  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
};

test('first message creates a durable session and the second reuses it', async ({ page }) => {
  const mock = await mockChat(page, { sessionId: null, chatRuns: [] });
  await openChat(page);

  await page.getByLabel('Message').fill('first message');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('first message')).toBeVisible();

  await page.getByLabel('Message').fill('second message');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('second message')).toBeVisible();

  const sent = mock.posts.filter((post) => post.path.endsWith('/runs'));
  expect(sent).toHaveLength(2);
  expect(typeof sent[0]!.body.session_id).toBe('string');
  // The conversation identity is stable across messages.
  expect(sent[1]!.body.session_id).toBe(sent[0]!.body.session_id);
});

test('a reload rebuilds the conversation from Control Plane state', async ({ page }) => {
  await mockChat(page, {
    sessionId: 'session-restored',
    chatRuns: [
      {
        run_id: 'run-1',
        status: 'completed',
        submitted_input: 'earlier question',
        session_id: 'session-restored',
      },
    ],
    archivedEvents: [
      { seq: 1, type: 'message.delta', payload: { delta: 'restored ' } },
      { seq: 2, type: 'message.delta', payload: { delta: 'answer' } },
    ],
  });

  await openChat(page);
  await expect(page.getByText('earlier question')).toBeVisible();
  await expect(page.getByText('restored answer')).toBeVisible();

  await page.reload();
  await expect(page.getByText('earlier question')).toBeVisible();
  await expect(page.getByText('restored answer')).toBeVisible();
});

test('replayed deltas do not duplicate the assistant text', async ({ page }) => {
  await mockChat(page, {
    sessionId: 'session-1',
    chatRuns: [
      { run_id: 'run-1', status: 'completed', submitted_input: 'ask', session_id: 'session-1' },
    ],
    // The canonical output arrives alongside the deltas that produced it.
    archivedEvents: [
      { seq: 1, type: 'message.delta', payload: { delta: 'one ' } },
      { seq: 2, type: 'message.delta', payload: { delta: 'two' } },
      { seq: 3, type: 'run.completed', payload: { output: 'one two' } },
    ],
  });

  await openChat(page);
  await expect(page.getByText('one two', { exact: true })).toBeVisible();
  const body = await page.locator('.chat-log').innerText();
  expect(body.match(/one two/g) ?? []).toHaveLength(1);
});

test('a terminal run never shows the stream as reconnecting', async ({ page }) => {
  await mockChat(page, {
    sessionId: 'session-1',
    chatRuns: [
      { run_id: 'run-1', status: 'running', submitted_input: 'work', session_id: 'session-1' },
    ],
    streamEvents: [
      { seq: 1, type: 'message.delta', payload: { delta: 'done' } },
      { seq: 2, type: 'asterism.run.terminal', payload: { status: 'completed' } },
    ],
  });

  await openChat(page);
  await expect(page.getByText('done')).toBeVisible();
  // The server closing after a terminal event is not a dropped connection.
  await page.waitForTimeout(1_500);
  await expect(page.getByText('Reconnecting')).toHaveCount(0);
});

test('an unexpected disconnect keeps trying to reconnect', async ({ page }) => {
  await mockChat(page, {
    sessionId: 'session-1',
    chatRuns: [
      { run_id: 'run-1', status: 'running', submitted_input: 'work', session_id: 'session-1' },
    ],
    // No terminal event: the stream simply ends, which is a failure.
    streamEvents: [{ seq: 1, type: 'message.delta', payload: { delta: 'partial' } }],
  });

  await openChat(page);
  await expect(page.getByText('partial')).toBeVisible();
  await expect(page.getByText('Reconnecting')).toBeVisible({ timeout: 5_000 });
});

test('single-flight blocks the composer while a run is active', async ({ page }) => {
  await mockChat(page, {
    sessionId: 'session-1',
    chatRuns: [
      { run_id: 'run-1', status: 'running', submitted_input: 'busy', session_id: 'session-1' },
    ],
  });

  await openChat(page);
  await expect(page.getByLabel('Message')).toBeDisabled();
  await expect(page.getByText('Waiting for the current turn to finish.')).toBeVisible();
});

test('an approval is answered inside the turn and submits once', async ({ page }) => {
  const mock = await mockChat(page, {
    sessionId: 'session-1',
    chatRuns: [
      {
        run_id: 'run-1',
        status: 'waiting_for_approval',
        submitted_input: 'do something risky',
        session_id: 'session-1',
      },
    ],
    streamEvents: [
      {
        seq: 1,
        type: 'approval.request',
        payload: { description: 'Write to the workspace', choices: ['once', 'deny'] },
      },
    ],
  });

  await openChat(page);
  await expect(page.getByText('Write to the workspace')).toBeVisible();
  const approve = page.getByRole('button', { name: 'Approve (once)' });
  await approve.click();
  await page.waitForTimeout(500);

  const approvals = mock.posts.filter((post) => post.path.endsWith('/approval'));
  expect(approvals).toHaveLength(1);
  expect(approvals[0]!.body.choice).toBe('once');
});

test('an active turn exposes cancellation', async ({ page }) => {
  const mock = await mockChat(page, {
    sessionId: 'session-1',
    chatRuns: [
      { run_id: 'run-1', status: 'running', submitted_input: 'long task', session_id: 'session-1' },
    ],
  });

  await openChat(page);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(400);
  expect(mock.posts.filter((post) => post.path.endsWith('/cancel'))).toHaveLength(1);
});

test('a retry is grouped with the turn it repeats, not shown as a new message', async ({
  page,
}) => {
  await mockChat(page, {
    sessionId: 'session-1',
    chatRuns: [
      {
        run_id: 'run-1',
        status: 'interrupted',
        submitted_input: 'the only question',
        session_id: 'session-1',
      },
      {
        run_id: 'run-2',
        status: 'completed',
        submitted_input: 'the only question',
        session_id: 'session-1',
        retry_of_run_id: 'run-1',
      },
    ],
    archivedEvents: [],
  });

  await openChat(page);
  // One user message, two attempts.
  await expect(page.getByText('the only question')).toHaveCount(1);
  await expect(page.getByText('Attempt 2 — retry')).toBeVisible();
});

test('the raw event journal stays reachable under technical details', async ({ page }) => {
  await mockChat(page, {
    sessionId: 'session-1',
    chatRuns: [
      { run_id: 'run-1', status: 'completed', submitted_input: 'ask', session_id: 'session-1' },
    ],
    archivedEvents: [
      { seq: 1, type: 'asterism.run.accepted', payload: {} },
      { seq: 2, type: 'message.delta', payload: { delta: 'a' } },
      { seq: 3, type: 'message.delta', payload: { delta: 'b' } },
      { seq: 4, type: 'asterism.run.terminal', payload: { status: 'completed' } },
    ],
  });

  await openChat(page);
  await page.getByText('Technical details').click();
  // Deltas are summarised rather than listed one per line.
  await expect(page.getByText('Assistant message — 2 events')).toBeVisible();
  await expect(page.getByText('#2–3')).toBeVisible();
  await expect(page.getByText('asterism.run.terminal')).toBeVisible();
});

test('a read-only user sees the conversation but cannot send or approve', async ({ page }) => {
  await mockChat(page, {
    permissions: ['organization.read', 'node.read', 'project.read', 'run.read'],
    userId: 'viewer',
    sessionId: 'session-1',
    chatRuns: [
      {
        run_id: 'run-1',
        status: 'waiting_for_approval',
        submitted_input: 'someone else asked',
        session_id: 'session-1',
        created_by_user_id: 'owner',
      },
    ],
    streamEvents: [
      {
        seq: 1,
        type: 'approval.request',
        payload: { description: 'Write to the workspace', choices: ['once', 'deny'] },
      },
    ],
  });

  await openChat(page);
  await expect(page.getByText('someone else asked')).toBeVisible();
  await expect(page.getByLabel('Message')).toBeDisabled();
  await expect(page.getByText('You do not have permission to send messages.')).toBeVisible();
  await expect(page.getByText('You do not have permission to answer approvals.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve (once)' })).toHaveCount(0);
});
