/**
 * The shared pool panel, from the outside.
 *
 * It used to start a login that added a credential to the pool. No credential
 * may go there any more -- an entry of the pool cannot be chosen for a project
 * -- so what matters now is that the panel offers nothing to press and says
 * honestly what the pool is.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderPanel } from '../src/provider-panel';

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

function view(over: Record<string, unknown> = {}) {
  return {
    node_id: 'node-2',
    state: 'required',
    provider: 'openai-codex',
    supported: true,
    device: null,
    ...over,
  };
}

function panel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderPanel nodeId="node-2" organizationId="org-a" />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('the shared credential pool', () => {
  it('offers no way to add a credential to it', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json(view()));
    panel();
    await screen.findByText('Shared credential pool');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Add a credential below/)).toBeTruthy();
    expect(
      fetch.mock.calls.every(([, init]) => ((init as RequestInit)?.method ?? 'GET') === 'GET'),
    ).toBe(true);
  });

  it('says its accounts cannot be chosen one by one', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json(
        view({
          state: 'authorized',
          // A relay still holding a code must not put one on screen here.
          device: {
            verification_uri: 'https://auth.openai.com/codex/device',
            user_code: 'K7QP-3WZN',
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
        }),
      ),
    );
    panel();
    await screen.findByText('Authorized');
    expect(screen.getByText(/cannot be chosen individually/)).toBeTruthy();
    expect(screen.queryByText('K7QP-3WZN')).toBeNull();
  });
});
