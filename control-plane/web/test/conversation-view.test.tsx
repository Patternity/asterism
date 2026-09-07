import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../src/App';
import type { SessionResponse } from '../src/types';

const session: SessionResponse = {
  user: { user_id: 'operator', email: 'operator@example.com', display_name: 'Operator' },
  active_organization: {
    organization_id: 'org-a',
    slug: 'alpha',
    display_name: 'Alpha',
    role: 'owner',
  },
  permissions: ['organization.read', 'node.read', 'node.manage', 'project.read', 'project.manage'],
};

const node = {
  node_id: 'node-a',
  display_name: 'Builder',
  connection_state: 'online',
  last_seen_at: '2026-08-30T10:00:00Z',
  software_version: '0.20.3',
  protocol_version: 1,
  identity_generation: 1,
  fingerprint: 'a'.repeat(64),
  capabilities: {},
  draining: false,
  revoked_at: null,
};

const project = {
  project_id: 'project-a',
  node_id: 'node-a',
  node_project_id: 'workshop',
  display_name: 'Workshop',
  enabled: true,
  available: true,
  first_seen_at: '2026-08-30T10:00:00Z',
  last_seen_at: '2026-08-30T10:00:00Z',
  metadata: {},
};

function json(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function renderConsole(path = '/') {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url === '/api/v1/auth/session') return json(session);
    if (url === '/api/v1/organizations')
      return json({ organizations: [session.active_organization] });
    if (url === '/api/v1/overview') return json({ counts: {}, recent_problem_runs: [] });
    if (url === '/api/v1/nodes') return json({ nodes: [node] });
    if (url === '/api/v1/projects') return json({ projects: [project] });
    if (url === '/api/v1/projects/project-a') {
      return json({
        project: {
          project_id: 'project-a',
          name: 'Workshop',
          slug: 'workshop',
          node_id: 'node-a',
          enabled: true,
          available: true,
          workspace: { mode: 'existing', repository_url: null, branch: null },
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
            supports_project_provisioning: false,
            project_provisioning_available: false,
            workspace_modes: [],
          },
        },
        node,
        active_run: null,
        recent_runs: [],
      });
    }
    if (url === '/api/v1/projects/project-a/chat') {
      return json({
        session_id: 'session-a',
        runs: [
          {
            run_id: 'run-1',
            node_id: 'node-a',
            project_id: 'project-a',
            node_run_id: 'node-run-1',
            status: 'completed',
            request_metadata: { input_length: 17, session_id: 'session-a' },
            created_by_user_id: 'operator',
            created_at: '2026-08-30T10:00:00Z',
            started_at: '2026-08-30T10:00:00Z',
            finished_at: '2026-08-30T10:00:02Z',
            terminal_reason: null,
            error_code: null,
            error_message: null,
            retry_of_run_id: null,
            last_event_seq: 2,
            submitted_input: 'Check the runtime',
            assistant_output: 'Runtime check completed.',
          },
        ],
        node_capabilities: {},
      });
    }
    if (url.startsWith('/api/v1/runs/run-1/events?')) {
      return json({
        events: [
          {
            run_id: 'run-1',
            seq: 1,
            event_type: 'tool.started',
            recorded_at: '2026-08-30T10:00:00.000Z',
            ingested_at: '2026-08-30T10:00:00.000Z',
            payload: { tool: 'runtime_check' },
          },
          {
            run_id: 'run-1',
            seq: 2,
            event_type: 'tool.completed',
            recorded_at: '2026-08-30T10:00:01.500Z',
            ingested_at: '2026-08-30T10:00:01.500Z',
            payload: { tool: 'runtime_check', version: '0.20.3' },
          },
        ],
      });
    }
    return json({});
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('conversation console view', () => {
  it('keeps the classic console as the default and remembers switching both ways', async () => {
    const user = userEvent.setup();
    const first = renderConsole();

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use conversation view' }));

    expect(
      await screen.findByRole('navigation', { name: 'Nodes and projects' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Builder')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workshop' })).toBeInTheDocument();
    expect(localStorage.getItem('asterism-console-view')).toBe('conversation');
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search projects/i)).not.toBeInTheDocument();

    first.unmount();
    renderConsole();
    expect(await screen.findByRole('button', { name: 'Use classic view' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use classic view' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(localStorage.getItem('asterism-console-view')).toBe('classic');
  });

  it('opens a real project conversation and reports its real connection state', async () => {
    localStorage.setItem('asterism-console-view', 'conversation');
    const user = userEvent.setup();
    renderConsole();

    await user.click(await screen.findByRole('link', { name: 'Workshop' }));

    expect(await screen.findByRole('heading', { name: 'Workshop' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Conversation' })).toBeInTheDocument();
    expect(screen.getByText('Builder connected')).toBeInTheDocument();
    expect(await screen.findByText('Runtime check completed.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tool results' })).toHaveTextContent('runtime_check');
    expect(screen.getByRole('region', { name: 'Tool results' })).toHaveTextContent('1.5s');
    expect(screen.getByRole('region', { name: 'Tool results' })).toHaveTextContent('0.20.3');
    expect(screen.getByRole('link', { name: 'Add Node' })).toHaveAttribute('href', '/nodes/add');
    expect(screen.getByRole('link', { name: 'Add project to Builder' })).toHaveAttribute(
      'href',
      '/projects/new?node=node-a',
    );
  });
});
