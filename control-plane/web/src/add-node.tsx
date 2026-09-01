import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';

import { apiRequest, jsonBody, scopedKey } from './api';
import { ErrorNotice, Loading, PageHeader } from './components';
import type { SessionResponse } from './types';
import {
  type InstallationRecord,
  bootstrapCommand,
  downloadDetail,
  failureExplanation,
  isTerminalState,
  stageLabel,
  useInstallationProgress,
} from './node-install';

/** The same accessors the other pages use, so scoping cannot diverge. */
function useProductSession(): SessionResponse {
  return useOutletContext<SessionResponse>();
}

function organizationId(session: SessionResponse): string {
  if (!session.active_organization) throw new Error('active organization is required');
  return session.active_organization.organization_id;
}

/**
 * Adding a Node.
 *
 * Two screens, deliberately: one asks for a name, the other shows a command and
 * then watches. Nothing here asks for an operator token, a systemd unit or a
 * project, because none of those are things a person adding a server should have
 * to know about.
 */
export function AddNodePage() {
  const session = useProductSession();
  const org = organizationId(session);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () =>
      apiRequest<{ installation: InstallationRecord; code: string }>('/api/v1/node-installations', {
        method: 'POST',
        ...jsonBody({ display_name: name.trim() || 'New Node' }),
      }),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: scopedKey(org, 'node-installations') });
      // The code is handed to the next screen through navigation state and is
      // never stored anywhere: it exists exactly once, in this reply, and a
      // reload is meant to lose it.
      navigate(`/nodes/add/${encodeURIComponent(result.installation.installation_id)}`, {
        state: { code: result.code },
      });
    },
  });

  if (!session.permissions.includes('node.manage')) {
    return (
      <section>
        <PageHeader title="Add Node" />
        <p>You do not have permission to add Nodes to this organization.</p>
      </section>
    );
  }

  return (
    <section>
      <PageHeader
        title="Add Node"
        description="Connect a server you control. You will get one command to run on it."
      />
      <form
        className="panel form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!create.isPending) create.mutate();
        }}
      >
        <label htmlFor="node-name">What should this server be called?</label>
        <input
          id="node-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Production west"
          maxLength={120}
          autoFocus
        />
        <p className="field-hint">
          A clean Linux server with a public network connection. Nothing needs to be installed on it
          first.
        </p>
        {create.isError ? <ErrorNotice error={create.error} /> : null}
        <button className="button primary" type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Add Node'}
        </button>
      </form>
    </section>
  );
}

/**
 * The command, and then the progress.
 *
 * The code is shown only while this browser still holds it — a reload loses it,
 * which is correct: it is a one-time credential, and pretending otherwise would
 * mean storing it. Progress survives the reload, because that comes from the
 * server.
 */
export function NodeInstallationPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const { installationId = '' } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);

  // Only ever from this navigation, never from storage.
  const code = (window.history.state?.usr as { code?: string } | undefined)?.code;

  const query = useQuery({
    queryKey: scopedKey(org, 'node-installation', installationId),
    queryFn: () =>
      apiRequest<{ installation: InstallationRecord }>(
        `/api/v1/node-installations/${encodeURIComponent(installationId)}`,
      ),
  });

  const { latest, state: streamState } = useInstallationProgress(installationId);

  const cancel = useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/node-installations/${encodeURIComponent(installationId)}/cancel`, {
        method: 'POST',
      }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: scopedKey(org, 'node-installation', installationId),
      }),
  });

  if (query.isPending) return <Loading label="Loading installation" />;
  if (query.isError) return <ErrorNotice error={query.error} />;

  const record = query.data.installation;
  // The live event wins while it is ahead of the fetched row, which is what
  // makes the bar move without polling.
  const stateNow = latest?.state ?? record.state;
  const percent = Math.max(latest?.percent ?? 0, record.percent);
  const bytesDone = latest?.bytes_done ?? record.bytes_done;
  const bytesTotal = latest?.bytes_total ?? record.bytes_total;
  const failureCode = latest?.failure_code ?? record.failure_code;
  const finished = isTerminalState(stateNow);
  const detail = downloadDetail({
    state: stateNow,
    bytes_done: bytesDone,
    bytes_total: bytesTotal,
  });
  const command = bootstrapCommand(window.location.origin);

  return (
    <section>
      <PageHeader
        title={record.display_name}
        {...(finished
          ? {}
          : {
              description:
                'Run this on the server. Leave this page open, or come back to it — progress is kept.',
            })}
      />

      {!finished ? (
        <article className="panel">
          <h2>1. Run this on your server</h2>
          <pre>
            <code>{command}</code>
          </pre>
          <button
            className="button"
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(command).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? 'Copied' : 'Copy command'}
          </button>

          <h2>2. Paste this code when it asks</h2>
          {code ? (
            <>
              <p className="install-code">
                <code>{code}</code>
              </p>
              <p className="field-hint">
                Shown once, here, and never again. It is not part of the command on purpose: a
                credential in a command line ends up in shell history.
              </p>
            </>
          ) : (
            <p className="field-hint">
              The code was shown when this installation was created and is not stored. If you no
              longer have it, cancel this and add the Node again.
            </p>
          )}
        </article>
      ) : null}

      <article className="panel">
        <h2>Progress</h2>
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Installation progress: ${stageLabel(stateNow)}`}
          className="progress-track"
        >
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
        {/* Announced rather than only drawn: a bar alone tells a screen reader
            nothing about which stage it is in. */}
        <p aria-live="polite" className="install-stage">
          {stageLabel(stateNow)}
          {detail ? <span className="install-bytes"> — {detail}</span> : null}
        </p>
        {streamState === 'reconnecting' && !finished ? (
          <p className="muted">Reconnecting to the live updates. The install carries on.</p>
        ) : null}
      </article>

      {stateNow === 'failed' ? (
        <div className="notice error" role="alert">
          <p>{failureExplanation(failureCode)}</p>
          {record.retryable ? (
            <button className="button" type="button" onClick={() => navigate('/nodes/add')}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      {stateNow === 'complete' && record.node_id ? (
        <div className="button-row">
          <button
            className="button primary"
            type="button"
            onClick={() => navigate(`/nodes/${encodeURIComponent(record.node_id as string)}`)}
          >
            Open this Node
          </button>
        </div>
      ) : null}

      {!finished ? (
        <div className="button-row">
          <button
            className="button"
            type="button"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
          >
            Cancel this installation
          </button>
        </div>
      ) : null}
    </section>
  );
}
