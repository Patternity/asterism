/**
 * Choosing a project's credential, from the outside.
 *
 * What must hold: the shared pool is offered as one thing and its entries never
 * one by one; a choice is sent by id; a change in flight is shown as a change in
 * flight; and a project whose credential cannot serve a run says why instead of
 * offering a composer the server would refuse.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
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
    'node.manage',
    'project.read',
    'project.manage',
    'run.read',
    'run.create',
  ],
};

const nodeCapabilities = {
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
  supports_project_credentials: true,
};

const node = {
  node_id: 'node-1',
  display_name: 'Builder',
  connection_state: 'online',
  last_seen_at: null,
  software_version: null,
  protocol_version: 1,
  identity_generation: 1,
  fingerprint: 'f'.repeat(64),
  capabilities: {},
  node_capabilities: nodeCapabilities,
  provider_state: 'authorized',
  draining: false,
  revoked_at: null,
};

const nodeDetail = {
  node,
  projects: [],
  provider_capabilities: {
    state: 'reported',
    status: 'ok',
    schema_version: 1,
    runtime_release: 'v0.1.0-alpha.27',
    providers: [
      {
        id: 'openai-codex',
        display_name: 'OpenAI Codex',
        auth_methods: ['device_authorization'],
        availability: 'available',
      },
    ],
    reported_at: null,
    recorded_at: '2026-09-14T10:00:00.000Z',
    stale: false,
  },
  credentials: [
    {
      credential_id: 'cred-pool',
      provider_id: 'openai-codex',
      auth_method: 'device_authorization',
      label: 'Existing credential',
      state: 'authorized',
      storage: 'legacy_shared_pool',
    },
    {
      credential_id: 'cred-own',
      provider_id: 'openai-codex',
      auth_method: 'device_authorization',
      label: 'Own account',
      state: 'authorized',
      storage: 'isolated',
    },
  ],
};

function project(credential: Record<string, unknown>) {
  return {
    project_id: 'prj_1',
    name: 'Example project',
    slug: 'example-project',
    node_id: 'node-1',
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
    node_capabilities: nodeCapabilities,
    provider_state: 'authorized',
    credential: {
      mode: 'legacy_shared_pool',
      current: null,
      assignment: { state: 'applied', requested: null, failure: null },
      run_block: null,
      ...credential,
    },
  };
}

function mockApi(routes: Record<string, unknown>) {
  const requests: { url: string; method: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === '/api/v1/auth/session') return response(owner);
    if (url === '/api/v1/organizations') return response({ organizations: [organization] });
    const body = routes[`${method} ${url}`] ?? routes[url];
    if (body === undefined) return response({ error: 'not_found' }, 404);
    return response(body);
  });
  return requests;
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
}

afterEach(() => vi.restoreAllMocks());

describe('creating a project on a credential of its own', () => {
  it('offers the shared pool as one choice, never its entries, and sends the id chosen', async () => {
    const requests = mockApi({
      '/api/v1/nodes': { nodes: [node] },
      '/api/v1/nodes/node-1': nodeDetail,
      'POST /api/v1/projects': { project: project({}) },
      '/api/v1/projects/prj_1': { project: project({}), node, active_run: null, recent_runs: [] },
      '/api/v1/projects/prj_1/chat': { session_id: null, runs: [] },
    });
    renderAt('/projects/new');

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/project name/i), 'Example project');
    await user.selectOptions(screen.getByLabelText(/^node$/i), 'node-1');
    const select = await screen.findByLabelText(/model credential/i);
    const labels = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toEqual(['Shared credential pool (legacy)', 'Own account (OpenAI Codex)']);

    await user.selectOptions(select, 'cred-own');
    await user.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      const created = requests.find((request) => request.method === 'POST');
      expect(created?.body).toMatchObject({ credential_id: 'cred-own' });
    });
  });
});

describe("a project's credential on its page", () => {
  it('states the shared pool honestly and asks the server to switch by id', async () => {
    const requests = mockApi({
      '/api/v1/projects/prj_1': { project: project({}), node, active_run: null, recent_runs: [] },
      '/api/v1/projects/prj_1/chat': { session_id: null, runs: [] },
      '/api/v1/nodes/node-1': nodeDetail,
      'PUT /api/v1/projects/prj_1/credential': { project: project({}), command_id: 'cmd-1' },
    });
    renderAt('/projects/prj_1');

    expect(
      await screen.findByText(/which one a run uses is not something that can be chosen/),
    ).toBeTruthy();
    const user = userEvent.setup();
    const select = await screen.findByLabelText(/^credential$/i);
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(select, 'cred-own');
    await user.click(screen.getByRole('button', { name: /use this credential/i }));

    await waitFor(() => {
      const put = requests.find((request) => request.method === 'PUT');
      expect(put?.url).toBe('/api/v1/projects/prj_1/credential');
      expect(put?.body).toEqual({ credential_id: 'cred-own' });
    });
  });

  it('shows a change in flight and does not offer another', async () => {
    mockApi({
      '/api/v1/projects/prj_1': {
        project: project({
          assignment: {
            state: 'pending',
            requested: {
              mode: 'isolated',
              credential: {
                credential_id: 'cred-own',
                label: 'Own account',
                provider_id: 'openai-codex',
                state: 'authorized',
              },
            },
            failure: null,
          },
          run_block: {
            error: 'credential_assignment_pending',
            message: "This project's credential is being changed.",
          },
        }),
        node,
        active_run: null,
        recent_runs: [],
      },
      '/api/v1/projects/prj_1/chat': { session_id: null, runs: [] },
      '/api/v1/nodes/node-1': nodeDetail,
    });
    renderAt('/projects/prj_1');

    expect(await screen.findByText(/Switching to Own account \(OpenAI Codex\)/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: /switching/i })).toBeDisabled();
  });

  it('says why a run cannot start and does not offer the composer', async () => {
    mockApi({
      '/api/v1/projects/prj_1': {
        project: project({
          mode: 'isolated',
          current: {
            credential_id: 'cred-own',
            label: 'Own account',
            provider_id: 'openai-codex',
            state: 'required',
          },
          run_block: {
            error: 'credential_not_authorized',
            message: "This project's credential needs to be authorized again.",
          },
        }),
        node: { ...node, provider_state: 'required' },
        active_run: null,
        recent_runs: [],
      },
      '/api/v1/projects/prj_1/chat': { session_id: null, runs: [] },
      '/api/v1/nodes/node-1': nodeDetail,
    });
    renderAt('/projects/prj_1');

    const reasons = await screen.findAllByText(/needs to be authorized again/);
    expect(reasons.length).toBeGreaterThan(0);
    // On its own credential, the shared pool's state is beside the point.
    expect(screen.queryByText(/has no model credential yet/)).toBeNull();
    const composer = screen.queryByPlaceholderText(/describe/i);
    if (composer) expect(composer).toBeDisabled();
  });
});
