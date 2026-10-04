/**
 * The Workdesk in a browser, both ways round.
 *
 * What must hold: a project on a Node without the bridge is told so, in words
 * that say the work still runs and that completion will not happen by itself;
 * a project on a Node with the bridge is told nothing, because there is nothing
 * to warn about.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionResponse } from '../src/types';

const organization = {
  organization_id: 'org-a',
  slug: 'alpha',
  display_name: 'Alpha',
  role: 'owner' as const,
};

const session = {
  user: { user_id: 'owner', email: 'owner@example.com', display_name: 'Owner' },
  active_organization: organization,
  permissions: ['organization.read', 'project.read', 'project.manage'],
  organizations: [organization],
} as unknown as SessionResponse;

// The page takes its session from the protected layout's outlet and its project
// from the route. Both are supplied here so the test is about the Workdesk.
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useOutletContext: () => session,
    useParams: () => ({ projectId: 'prj_1' }),
  };
});

const { WorkdeskPage } = await import('../src/workdesk');

/** The sentence the server sends for a Node that cannot report. */
const LEGACY_EXPLANATION =
  'This project runs on a Node that cannot report structured progress. Tasks still run, but ' +
  'there is no plan, no step-by-step progress and no automatic completion: a run that succeeds ' +
  'goes to review for somebody to look at.';

const columns = [
  { state: 'backlog', label: 'Backlog' },
  { state: 'ready', label: 'Ready' },
  { state: 'running', label: 'Running' },
  { state: 'waiting_input', label: 'Waiting for input' },
  { state: 'review', label: 'Ready for review' },
  { state: 'completed', label: 'Completed' },
  { state: 'failed', label: 'Failed' },
  { state: 'cancelled', label: 'Cancelled' },
];

function mount(reports: { supported: boolean; available: boolean; explanation: string | null }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ columns, tasks: [], structured_reports: reports }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WorkdeskPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a project whose Node cannot report', () => {
  const legacy = { supported: false, available: false, explanation: LEGACY_EXPLANATION };

  it('says the work runs but no plan and no automatic completion are coming', async () => {
    mount(legacy);
    // Queried by the words a person reads: `role="status"` is also the
    // loading indicator's, so matching on it caught the spinner instead.
    const notice = await screen.findByText(/tasks still run/i);
    expect(notice.textContent).toMatch(/no plan/i);
    expect(notice.textContent).toMatch(/no automatic completion/i);
    expect(notice.textContent).toMatch(/goes to review/i);
  });

  it('still offers task creation, because execution itself is available', async () => {
    mount(legacy);
    expect(await screen.findByRole('heading', { name: 'New task' })).toBeTruthy();
  });
});

describe('a project whose Node reports', () => {
  it('warns about nothing', async () => {
    mount({ supported: true, available: true, explanation: null });
    await screen.findByRole('heading', { name: 'Workdesk' });
    // No warning of either kind once the board has rendered.
    expect(screen.queryByText(/cannot report structured progress/i)).toBeNull();
    expect(screen.queryByText(/offline right now/i)).toBeNull();
  });
});

describe('a Node that has the bridge but is unreachable', () => {
  it('says it is offline rather than that it is incapable', async () => {
    mount({
      supported: true,
      available: false,
      explanation:
        'This project’s Node can report structured progress, but it is offline right now, ' +
        'so nothing will arrive until it reconnects.',
    });
    const notice = await screen.findByText(/offline right now/i);
    expect(notice.textContent).toMatch(/offline/i);
    // Sending somebody to upgrade a Node that is merely unreachable wastes
    // their afternoon, so the two sentences stay distinct.
    expect(notice.textContent).not.toMatch(/cannot report/i);
  });
});
