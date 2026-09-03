/**
 * The provider panel, from the outside.
 *
 * Both failures here were reported from a browser rather than caught by a test:
 * pressing the button appeared to do nothing until the page was reloaded, and
 * after the code was approved it stayed on screen telling a person to approve
 * something already approved.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  const client = new QueryClient({
    defaultOptions: {
      // Only the panel's own polling may drive this test. Refetching on focus
      // or reconnect would hide the very gap being reproduced.
      queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProviderPanel nodeId="node-2" organizationId="org-a" canManage />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('waiting for a Node to print a code', () => {
  it('keeps asking after the button is pressed, without a reload', async () => {
    // The Node needs a few seconds to reach the provider. Until it answers the
    // state is still `required` and there is no device — the exact combination
    // that used to stop the panel polling and leave it empty.
    // The Node stays silent for several polls, which is what it really does:
    // the command has to reach it, it has to reach the provider, and only then
    // does the Control Plane record `authorizing`. The one refetch the press
    // triggers lands squarely inside that silence.
    const withDevice = view({
      state: 'authorizing',
      device: {
        verification_uri: 'https://auth.openai.com/codex/device',
        user_code: 'K7QP-3WZN',
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    let get = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        return json({ node_id: 'node-2' }, 202);
      }
      get += 1;
      return json(get <= 4 ? view() : withDevice);
    });

    panel();
    await screen.findByText('Authorization required');
    await userEvent.click(screen.getByRole('button', { name: 'Authorize provider' }));

    // No reload, no second press.
    await waitFor(
      () => expect(screen.getByTestId('provider-user-code')).toHaveTextContent('K7QP-3WZN'),
      {
        timeout: 10_000,
      },
    );
  }, 15_000);
});

describe('once the code has been approved', () => {
  it('stops showing it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json(
        view({
          state: 'authorized',
          // The relay may still be holding it; the panel must not show it.
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
    expect(screen.queryByTestId('provider-user-code')).toBeNull();
    expect(screen.queryByText('Approve this code')).toBeNull();
  });
});
