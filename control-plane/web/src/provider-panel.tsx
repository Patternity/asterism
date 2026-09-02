import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { apiRequest, jsonBody, scopedKey } from './api';
import {
  type ProviderAuthorizationView,
  canAuthorize,
  formatRemaining,
  providerExplanation,
  providerLabel,
  remainingSeconds,
} from './provider-authorization';

/**
 * Authorizing a Node's model provider, without a terminal.
 *
 * The code shown here came from the Node over the control channel and lives in
 * the Control Plane's memory until it expires. It is not stored anywhere it
 * could be recovered from, which is why a reload offers a fresh attempt instead
 * of showing the same code again.
 */
export function ProviderPanel({
  nodeId,
  organizationId,
  canManage,
}: {
  nodeId: string;
  organizationId: string | undefined;
  canManage: boolean;
}) {
  const client = useQueryClient();
  const [now, setNow] = useState(() => Date.now());

  const query = useQuery({
    queryKey: scopedKey(organizationId, 'node-provider', nodeId),
    queryFn: () =>
      apiRequest<ProviderAuthorizationView>(
        `/api/v1/nodes/${encodeURIComponent(nodeId)}/provider-authorization`,
      ),
    // Polled only while a person is waiting on it. The Node reports its state on
    // every reconnection anyway, so this is about the minutes between pressing
    // the button and approving the code, not a permanent heartbeat.
    refetchInterval: (query) =>
      query.state.data?.state === 'authorizing' || query.state.data?.device ? 3_000 : false,
  });

  const begin = useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/nodes/${encodeURIComponent(nodeId)}/provider-authorization`, {
        method: 'POST',
        ...jsonBody({}),
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: scopedKey(organizationId, 'node-provider', nodeId) }),
  });

  const cancel = useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/nodes/${encodeURIComponent(nodeId)}/provider-authorization/cancel`, {
        method: 'POST',
        ...jsonBody({}),
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: scopedKey(organizationId, 'node-provider', nodeId) }),
  });

  // Ticks only while a code is on screen, so the remaining time is honest
  // without the page doing work when nothing is waiting.
  const device = query.data?.device ?? null;
  useEffect(() => {
    if (!device) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [device]);

  if (query.isPending) return null;
  if (query.isError) return null;

  const view = query.data;
  const remaining = device ? remainingSeconds(device.expires_at, now) : 0;
  const expired = Boolean(device) && remaining <= 0;

  return (
    <article className="panel">
      <h2>Model provider</h2>
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          <span className={`badge provider-${view.state}`}>{providerLabel(view.state)}</span>
        </dd>
        {view.provider ? (
          <>
            <dt>Provider</dt>
            <dd>{view.provider}</dd>
          </>
        ) : null}
      </dl>
      <p className="muted">{providerExplanation(view.state)}</p>

      {device && !expired ? (
        <div className="provider-device">
          <h3>Approve this code</h3>
          <ol>
            <li>
              Open{' '}
              <a href={device.verification_uri} target="_blank" rel="noreferrer noopener">
                {device.verification_uri}
              </a>
            </li>
            <li>
              Enter this code:{' '}
              <code className="provider-code" data-testid="provider-user-code">
                {device.user_code}
              </code>
            </li>
          </ol>
          <div className="button-row">
            <button
              className="button"
              type="button"
              onClick={() => void navigator.clipboard?.writeText(device.user_code)}
            >
              Copy code
            </button>
            {canManage ? (
              <button
                className="button"
                type="button"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                Cancel
              </button>
            ) : null}
          </div>
          {/* Announced rather than only drawn: a countdown nobody hears is not a
              countdown for everyone. */}
          <p aria-live="polite" className="muted">
            {`This code expires in ${formatRemaining(remaining)}. It is shown once and is not stored.`}
          </p>
        </div>
      ) : null}

      {expired ? (
        <p className="notice" role="alert">
          That code expired before it was approved. Starting again issues a new one.
        </p>
      ) : null}

      {canManage && canAuthorize(view) ? (
        <div className="button-row">
          <button
            className="button primary"
            type="button"
            onClick={() => begin.mutate()}
            disabled={begin.isPending}
          >
            {begin.isPending ? 'Starting…' : 'Authorize provider'}
          </button>
        </div>
      ) : null}

      {view.state === 'authorizing' && !device ? (
        <p aria-live="polite" className="muted">
          Waiting for the Node to offer a code…
        </p>
      ) : null}

      {!canManage && view.state !== 'authorized' ? (
        <p className="muted">
          Someone with permission to manage Nodes has to authorize this one before its projects can
          run.
        </p>
      ) : null}
    </article>
  );
}
