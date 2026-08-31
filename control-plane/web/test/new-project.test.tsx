/**
 * Creating a project, and being told the truth about it afterwards.
 *
 * The failure this guards against is a console that treats "the server accepted
 * my request" as "the project is running". Nothing here may show chat, or a
 * runnable project, before the server says `ready` — and the server only says
 * that after a Node's worker has answered.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';
import type { SessionResponse } from '../src/types';

function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

const organization = {
  organization_id: 'org-a',
  slug: 'alpha',
  display_name: 'Alpha',
  role: 'owner' as const,
};

const owner: SessionResponse = {
  user: { user_id: 'owner', email: 'owner@example.com', display_name: 'Owner' },
  active_organization: organization,
  permissions: [
    'organization.read',
    'node.read',
    'project.read',
    'project.manage',
    'run.read',
    'run.create',
  ],
};

const viewer: SessionResponse = {
  ...owner,
  user: { user_id: 'viewer', email: 'viewer@example.com', display_name: 'Viewer' },
  permissions: ['organization.read', 'node.read', 'project.read', 'run.read'],
};

const capabilities = (overrides: Record<string, unknown> = {}) => ({
  connection_status: 'online',
  capabilities_known: true,
  run_approval_policy: [],
  supports_run_approval_policy: false,
  run_approval_policy_available: false,
  run_attachments: [],
  image_attachments_available: false,
  supports_project_provisioning: true,
  project_provisioning_available: true,
  workspace_modes: ['empty', 'clone'],
  ...overrides,
});

const compatibleNode = {
  node_id: 'node-1',
  display_name: 'Builder',
  connection_state: 'online',
  last_seen_at: null,
  software_version: null,
  protocol_version: 1,
  identity_generation: 1,
  fingerprint: 'f'.repeat(64),
  capabilities: {},
  node_capabilities: capabilities(),
  draining: false,
  revoked_at: null,
};

const legacyNode = {
  ...compatibleNode,
  node_id: 'node-legacy',
  display_name: 'Older node',
  node_capabilities: capabilities({
    supports_project_provisioning: false,
    project_provisioning_available: false,
    workspace_modes: [],
  }),
};

function project(overrides: Record<string, unknown> = {}) {
  return {
    project_id: 'prj_1',
    name: 'Example project',
    slug: 'example-project',
    node_id: 'node-1',
    enabled: true,
    available: false,
    workspace: { mode: 'empty', repository_url: null, branch: null },
    provisioning: {
      state: 'pending',
      generation: 1,
      failure: null,
      failure_message: null,
      retryable: false,
    },
    can_run: false,
    node_online: true,
    node_capabilities: capabilities(),
    ...overrides,
  };
}

interface Route {
  body: unknown;
  status?: number;
}

/**
 * Serve the routes a page asks for, and record what it sent.
 *
 * `sequence` lets one URL answer differently on successive calls, which is how
 * a provisioning transition is observed without inventing a second stream.
 */
function mockApi(
  session: SessionResponse,
  routes: Record<string, Route | Route[]>,
): { requests: { url: string; method: string; body: unknown }[] } {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const counters = new Map<string, number>();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url === '/api/v1/auth/session') return response(session);
    if (url === '/api/v1/organizations') return response({ organizations: [organization] });
    const route = routes[`${method} ${url}`] ?? routes[url];
    if (route === undefined) return response({ error: 'not_found' }, 404);
    if (Array.isArray(route)) {
      const index = counters.get(url) ?? 0;
      counters.set(url, index + 1);
      const chosen = route[Math.min(index, route.length - 1)]!;
      return response(chosen.body, chosen.status ?? 200);
    }
    return response(route.body, route.status ?? 200);
  });
  return { requests };
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('who may start a project', () => {
  it('offers the action to a role the server would accept', async () => {
    mockApi(owner, { '/api/v1/projects': { body: { projects: [] } } });
    renderAt('/projects');
    expect(await screen.findByRole('link', { name: /new project/i })).toBeTruthy();
  });

  it('does not offer a form that would always be refused', async () => {
    // The button is hidden because the server would refuse, not instead of the
    // server refusing: the check there is what actually enforces this.
    mockApi(viewer, { '/api/v1/projects': { body: { projects: [] } } });
    renderAt('/projects');
    await screen.findByText(/no projects are registered/i);
    expect(screen.queryByRole('link', { name: /new project/i })).toBeNull();
  });
});

describe('choosing where a project runs', () => {
  it('offers a Node whose build never mentions project provisioning, but not for selection', async () => {
    mockApi(owner, { '/api/v1/nodes': { body: { nodes: [compatibleNode, legacyNode] } } });
    renderAt('/projects/new');
    // Listed with a reason, so the operator sees it exists and why it is out.
    const option = (await screen.findByRole('option', {
      name: /older node/i,
    })) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toMatch(/support|older|cannot/i);
  });

  it('says so plainly when nothing can build a project', async () => {
    mockApi(owner, { '/api/v1/nodes': { body: { nodes: [legacyNode] } } });
    renderAt('/projects/new');
    expect(await screen.findByText(/no connected node can host/i)).toBeTruthy();
    // No form at all: a form with nothing selectable is a dead end.
    expect(screen.queryByRole('button', { name: /create project/i })).toBeNull();
  });
});

describe('submitting the form', () => {
  it('sends the empty intent and shows the project as not yet built', async () => {
    const created = project();
    const { requests } = mockApi(owner, {
      '/api/v1/nodes': { body: { nodes: [compatibleNode] } },
      'POST /api/v1/projects': { body: { project: created }, status: 201 },
      '/api/v1/projects/prj_1': {
        body: { project: created, node: compatibleNode, active_run: null, recent_runs: [] },
      },
    });
    renderAt('/projects/new');

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/project name/i), 'Example project');
    await user.selectOptions(screen.getByLabelText(/^node$/i), 'node-1');
    await user.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      expect(requests.some((request) => request.method === 'POST')).toBe(true);
    });
    const sent = requests.find((request) => request.method === 'POST')!;
    expect(sent.body).toMatchObject({ workspace: { mode: 'empty' } });
    // Nothing about the host is decided here, so nothing about it is sent.
    expect(JSON.stringify(sent.body)).not.toContain('repository_url');

    // Shown as the server described it: queued, and with no way to send a turn.
    expect(await screen.findByText(/queued for its node/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/describe the task/i)).toBeNull();
  });

  it('keeps a repository out of the payload after switching back to empty', async () => {
    const { requests } = mockApi(owner, {
      '/api/v1/nodes': { body: { nodes: [compatibleNode] } },
      'POST /api/v1/projects': { body: { project: project() }, status: 201 },
      '/api/v1/projects/prj_1': {
        body: { project: project(), node: compatibleNode, active_run: null, recent_runs: [] },
      },
    });
    renderAt('/projects/new');

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/project name/i), 'Example project');
    await user.selectOptions(screen.getByLabelText(/^node$/i), 'node-1');
    await user.click(screen.getByRole('radio', { name: /clone an existing/i }));
    await user.type(
      screen.getByLabelText(/repository address/i),
      'https://example.com/organization/repository.git',
    );
    // Changed their mind. The fields disappear from view; they must also
    // disappear from what is sent.
    await user.click(screen.getByRole('radio', { name: /create an empty/i }));
    await user.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      expect(requests.some((request) => request.method === 'POST')).toBe(true);
    });
    const sent = requests.find((request) => request.method === 'POST')!;
    expect(JSON.stringify(sent.body)).not.toContain('example.com');
  });

  it('shows the server’s typed refusal and keeps what was typed', async () => {
    mockApi(owner, {
      '/api/v1/nodes': { body: { nodes: [compatibleNode] } },
      'POST /api/v1/projects': { body: { error: 'project_slug_conflict' }, status: 409 },
    });
    renderAt('/projects/new');

    const user = userEvent.setup();
    const name = await screen.findByLabelText(/project name/i);
    await user.type(name, 'Example project');
    await user.selectOptions(screen.getByLabelText(/^node$/i), 'node-1');
    await user.click(screen.getByRole('button', { name: /create project/i }));

    // The message is chosen from the code, not from matching English prose.
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe('Example project');
  });
});

describe('watching a project become ready', () => {
  it('moves from provisioning to ready and only then offers chat', async () => {
    const provisioning = project({
      provisioning: {
        state: 'provisioning',
        generation: 1,
        failure: null,
        failure_message: null,
        retryable: false,
      },
    });
    const ready = project({
      available: true,
      can_run: true,
      provisioning: {
        state: 'ready',
        generation: 1,
        failure: null,
        failure_message: null,
        retryable: false,
      },
    });
    mockApi(owner, {
      '/api/v1/projects/prj_1': [
        {
          body: { project: provisioning, node: compatibleNode, active_run: null, recent_runs: [] },
        },
        { body: { project: ready, node: compatibleNode, active_run: null, recent_runs: [] } },
      ],
      '/api/v1/projects/prj_1/chat': { body: { session_id: null, runs: [] } },
    });
    renderAt('/projects/prj_1');

    expect(await screen.findByText(/is preparing the workspace/i)).toBeTruthy();
    // The composer appears only once the server says the project is ready.
    expect(screen.queryByPlaceholderText(/describe the task/i)).toBeNull();
    expect(
      await screen.findByPlaceholderText(/describe the task/i, undefined, { timeout: 6_000 }),
    ).toBeTruthy();
  }, 15_000);

  it('renders a failure without leaking anything about the host', async () => {
    const failed = project({
      provisioning: {
        state: 'failed',
        generation: 1,
        failure: 'repository_clone_failed',
        failure_message: 'the repository could not be cloned',
        retryable: true,
      },
    });
    mockApi(owner, {
      '/api/v1/projects/prj_1': {
        body: { project: failed, node: compatibleNode, active_run: null, recent_runs: [] },
      },
    });
    const { container } = { container: document.body };
    renderAt('/projects/prj_1');

    expect(await screen.findByRole('button', { name: /retry/i })).toBeTruthy();
    for (const leak of [
      'workspace_path',
      'hermes_profile',
      'hermes_api_key_ref',
      'runtime_endpoint',
      '/var/lib/asterism',
      '18642',
    ]) {
      expect(container.textContent).not.toContain(leak);
    }
  });

  it('offers no retry for a failure that retrying cannot change', async () => {
    const hopeless = project({
      provisioning: {
        state: 'failed',
        generation: 1,
        failure: 'node_capability_unavailable',
        failure_message: null,
        retryable: false,
      },
    });
    mockApi(owner, {
      '/api/v1/projects/prj_1': {
        body: { project: hopeless, node: compatibleNode, active_run: null, recent_runs: [] },
      },
    });
    renderAt('/projects/prj_1');

    await screen.findByText(/trying again will not change this/i);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('asks the server once per retry and shows what it answered', async () => {
    const failed = project({
      provisioning: {
        state: 'failed',
        generation: 1,
        failure: 'repository_clone_failed',
        failure_message: null,
        retryable: true,
      },
    });
    const retried = project({
      provisioning: {
        state: 'pending',
        generation: 2,
        failure: null,
        failure_message: null,
        retryable: false,
      },
    });
    const { requests } = mockApi(owner, {
      '/api/v1/projects/prj_1': [
        { body: { project: failed, node: compatibleNode, active_run: null, recent_runs: [] } },
        { body: { project: retried, node: compatibleNode, active_run: null, recent_runs: [] } },
      ],
      'POST /api/v1/projects/prj_1/provisioning/retry': { body: { project: retried } },
    });
    renderAt('/projects/prj_1');

    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: /retry/i });
    await user.click(button);
    await user.click(button).catch(() => undefined);

    await waitFor(() => {
      const retries = requests.filter((request) => request.url.endsWith('/provisioning/retry'));
      // A second click while the first is in flight must not start a second
      // attempt: the generation would move twice for one operator decision.
      expect(retries).toHaveLength(1);
    });
  });
});

describe('a project that was already running before provisioning existed', () => {
  it('behaves exactly as it did, with no provisioning surface', async () => {
    const legacy = {
      ...project({ available: true, can_run: true }),
      provisioning: undefined,
      workspace: null,
    };
    mockApi(owner, {
      '/api/v1/projects/prj_1': {
        body: { project: legacy, node: compatibleNode, active_run: null, recent_runs: [] },
      },
      '/api/v1/projects/prj_1/chat': { body: { session_id: null, runs: [] } },
    });
    renderAt('/projects/prj_1');

    // No state of its own, and it was already running: it reads as ready.
    expect(await screen.findByPlaceholderText(/describe the task/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
