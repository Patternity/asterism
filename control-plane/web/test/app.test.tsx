import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';
import type { SessionResponse } from '../src/types';

function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

function renderApp(path: string, session: SessionResponse, routes: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url === '/api/v1/auth/session') return response(session);
    if (url === '/api/v1/organizations') {
      return response({ organizations: [session.active_organization] });
    }
    const body = routes[url];
    return body === undefined ? response({ error: 'not_found' }, 404) : response(body);
  });
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

const organization = {
  organization_id: 'org-a',
  slug: 'alpha',
  display_name: 'Alpha',
  role: 'viewer' as const,
};

const viewer: SessionResponse = {
  user: { user_id: 'viewer', email: 'viewer@example.com', display_name: 'Viewer' },
  active_organization: organization,
  permissions: ['organization.read', 'node.read', 'project.read', 'run.read'],
};

describe('operations console authorization', () => {
  it('renders the overview and hides privileged navigation for Viewer', async () => {
    renderApp('/', viewer, {
      '/api/v1/overview': {
        counts: {
          online_nodes: 1,
          offline_nodes: 0,
          draining_nodes: 0,
          enabled_projects: 2,
          active_runs: 1,
          waiting_approvals: 0,
        },
        recent_problem_runs: [],
      },
    });
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Members' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit' })).not.toBeInTheDocument();
  });

  it('hides destructive Node controls when the server omits permission', async () => {
    renderApp('/nodes/node-a', viewer, {
      '/api/v1/nodes/node-a': {
        node: {
          node_id: 'node-a',
          display_name: 'Builder',
          connection_state: 'online',
          last_seen_at: null,
          software_version: '0.1.0',
          protocol_version: 1,
          identity_generation: 1,
          fingerprint: 'a'.repeat(64),
          capabilities: {},
          draining: false,
          revoked_at: null,
        },
        projects: [],
      },
    });
    expect(await screen.findByRole('heading', { name: 'Builder' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Drain' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });
});
