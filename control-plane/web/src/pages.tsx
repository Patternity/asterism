import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useOutletContext, useParams } from 'react-router-dom';

import { supportedChoices } from './approval-choices';
import { ApiError, apiRequest, jsonBody, scopedKey } from './api';
import { useLogin, useOrganizations, useSelectOrganization, useSession } from './auth';
import { ConfirmButton, Empty, ErrorNotice, Loading, PageHeader, StatusBadge } from './components';
import { ProjectChat } from './chat';
import { assistantText, useRunEvents } from './sse';
import {
  buildCreatePayload,
  failureMessage,
  isSettling,
  nodeIsSelectable,
  nodeUnavailableReason,
  stateSummary,
  suggestSlug,
  validate,
  type FieldErrors,
  type FormValues,
  type WorkspaceMode,
} from './project-form';
import type {
  AuditRecord,
  InvitationRecord,
  MemberRecord,
  NodeRecord,
  OrganizationSummary,
  ProjectRecord,
  ProvisionedProject,
  RunEvent,
  RunRecord,
  SessionResponse,
} from './types';

function useProductSession(): SessionResponse {
  return useOutletContext<SessionResponse>();
}

function organizationId(session: SessionResponse): string {
  if (!session.active_organization) throw new Error('active organization is required');
  return session.active_organization.organization_id;
}

function formatTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : 'Never';
}

export function LoginPage() {
  const session = useSession();
  const login = useLogin();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  if (session.data)
    return (
      <Navigate to={session.data.active_organization ? '/' : '/select-organization'} replace />
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate(
      { email, password },
      { onSuccess: (value) => navigate(value.active_organization ? '/' : '/select-organization') },
    );
  };
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="brand auth-brand">
          <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
          <strong>Asterism</strong>
        </div>
        <h1 id="login-title">Operations console</h1>
        <p>Sign in with an invited account. Public registration is not available.</p>
        <form onSubmit={submit}>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {login.error ? <ErrorNotice error={login.error} /> : null}
          <button className="button primary wide" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

export function OrganizationSelectorPage() {
  const session = useSession();
  const organizations = useOrganizations();
  const select = useSelectOrganization();
  const navigate = useNavigate();
  if (session.isPending || organizations.isPending)
    return <Loading label="Loading organizations" />;
  if (!session.data) return <Navigate to="/login" replace />;
  if (session.data.active_organization) return <Navigate to="/" replace />;
  return (
    <main className="auth-page">
      <section className="auth-card wide-card">
        <h1>Select an organization</h1>
        <p>Your active organization scopes every Node, project, run, and event query.</p>
        <div className="organization-grid">
          {organizations.data?.organizations.map((organization) => (
            <button
              key={organization.organization_id}
              className="organization-option"
              disabled={select.isPending}
              onClick={() =>
                select.mutate(organization.organization_id, { onSuccess: () => navigate('/') })
              }
            >
              <strong>{organization.display_name}</strong>
              <span>{organization.role}</span>
            </button>
          ))}
        </div>
        {select.error ? <ErrorNotice error={select.error} /> : null}
      </section>
    </main>
  );
}

export function InvitationAcceptPage() {
  const { token = '' } = useParams();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const accepted = useMutation({
    mutationFn: () =>
      apiRequest('/api/v1/invitations/accept', {
        method: 'POST',
        ...jsonBody({ token, display_name: displayName, password }),
      }),
  });
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Accept invitation</h1>
        {accepted.isSuccess ? (
          <>
            <div className="notice success" role="status">
              Invitation accepted.
            </div>
            <Link className="button primary wide" to="/login">
              Continue to sign in
            </Link>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              accepted.mutate();
            }}
          >
            <label htmlFor="display-name">Display name</label>
            <input
              id="display-name"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <label htmlFor="new-password">Password</label>
            <input
              id="new-password"
              type="password"
              minLength={12}
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {accepted.error ? <ErrorNotice error={accepted.error} /> : null}
            <button className="button primary wide" disabled={accepted.isPending}>
              Accept invitation
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

export function OverviewPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const overview = useQuery({
    queryKey: scopedKey(org, 'overview'),
    queryFn: () =>
      apiRequest<{ counts: Record<string, number>; recent_problem_runs: RunRecord[] }>(
        '/api/v1/overview',
      ),
  });
  if (overview.isPending) return <Loading label="Loading overview" />;
  if (overview.error) return <ErrorNotice error={overview.error} />;
  const metrics = [
    ['Online Nodes', overview.data.counts.online_nodes ?? 0],
    ['Offline Nodes', overview.data.counts.offline_nodes ?? 0],
    ['Draining Nodes', overview.data.counts.draining_nodes ?? 0],
    ['Enabled projects', overview.data.counts.enabled_projects ?? 0],
    ['Active runs', overview.data.counts.active_runs ?? 0],
    ['Waiting approvals', overview.data.counts.waiting_approvals ?? 0],
  ];
  return (
    <>
      <PageHeader
        title="Overview"
        description={`Operational state for ${session.active_organization?.display_name}.`}
      />
      <section className="metric-grid" aria-label="Organization metrics">
        {metrics.map(([label, value]) => (
          <article className="metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </section>
      <section className="panel">
        <h2>Recent problem runs</h2>
        {overview.data.recent_problem_runs.length === 0 ? (
          <Empty>No failed, interrupted, or lost runs.</Empty>
        ) : (
          <RunTable runs={overview.data.recent_problem_runs} />
        )}
      </section>
    </>
  );
}

function RunTable({ runs }: { runs: RunRecord[] }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Runs</caption>
        <thead>
          <tr>
            <th>Run</th>
            <th>Status</th>
            <th>Created</th>
            <th>Finished</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.run_id}>
              <td>
                <Link to={`/runs/${run.run_id}`} className="mono-link">
                  {run.run_id.slice(0, 12)}…
                </Link>
              </td>
              <td>
                <StatusBadge status={run.status} />
              </td>
              <td>{formatTime(run.created_at)}</td>
              <td>{formatTime(run.finished_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NodesPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const query = useQuery({
    queryKey: scopedKey(org, 'nodes'),
    queryFn: () => apiRequest<{ nodes: NodeRecord[] }>('/api/v1/nodes'),
  });
  if (query.isPending) return <Loading label="Loading Nodes" />;
  if (query.error) return <ErrorNotice error={query.error} />;
  return (
    <>
      <PageHeader
        title="Nodes"
        description="Outbound-connected execution hosts in this organization."
      />
      {query.data.nodes.length === 0 ? (
        <Empty>No Nodes are enrolled.</Empty>
      ) : (
        <div className="card-grid">
          {query.data.nodes.map((node) => (
            <Link className="resource-card" to={`/nodes/${node.node_id}`} key={node.node_id}>
              <div>
                <h2>{node.display_name}</h2>
                <StatusBadge status={node.connection_state} />
              </div>
              <dl>
                <dt>Last seen</dt>
                <dd>{formatTime(node.last_seen_at)}</dd>
                <dt>Version</dt>
                <dd>{node.software_version ?? 'Unknown'}</dd>
              </dl>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function NodeDetailPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const { nodeId = '' } = useParams();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: scopedKey(org, 'node', nodeId),
    queryFn: () =>
      apiRequest<{ node: NodeRecord; projects: ProjectRecord[] }>(
        `/api/v1/nodes/${encodeURIComponent(nodeId)}`,
      ),
  });
  const action = useMutation({
    mutationFn: ({ path, body = {} }: { path: string; body?: unknown }) =>
      apiRequest(`/api/v1/nodes/${encodeURIComponent(nodeId)}/${path}`, {
        method: 'POST',
        ...jsonBody(body),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: scopedKey(org, 'node', nodeId) }),
  });
  if (query.isPending) return <Loading label="Loading Node" />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const node = query.data.node;
  const canManage = session.permissions.includes('node.manage');
  return (
    <>
      <PageHeader
        title={node.display_name}
        description={node.node_id}
        actions={
          canManage ? (
            <div className="button-row">
              <ConfirmButton
                label="Drain"
                confirmLabel="Drain Node"
                description="The Node will stop accepting new work until its daemon is restarted."
                onConfirm={() => action.mutate({ path: 'drain' })}
              />
              <ConfirmButton
                danger
                label="Revoke"
                confirmLabel="Revoke identity"
                description="The current Node identity will be revoked and its live session disconnected."
                onConfirm={() =>
                  action.mutate({
                    path: 'revoke',
                    body: { reason: 'Revoked from operations console' },
                  })
                }
              />
            </div>
          ) : null
        }
      />
      {action.error ? <ErrorNotice error={action.error} /> : null}
      <section className="detail-grid">
        <article className="panel">
          <h2>Connection</h2>
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={node.connection_state} />
            </dd>
            <dt>Last seen</dt>
            <dd>{formatTime(node.last_seen_at)}</dd>
            <dt>Software</dt>
            <dd>{node.software_version ?? 'Unknown'}</dd>
            <dt>Protocol</dt>
            <dd>{node.protocol_version ?? 'Unknown'}</dd>
          </dl>
        </article>
        <article className="panel">
          <h2>Identity</h2>
          <dl className="facts">
            <dt>Generation</dt>
            <dd>{node.identity_generation}</dd>
            <dt>Fingerprint</dt>
            <dd className="fingerprint">{node.fingerprint}</dd>
          </dl>
        </article>
      </section>
      <section className="panel">
        <h2>Capabilities</h2>
        <pre className="safe-json">{JSON.stringify(node.capabilities, null, 2)}</pre>
      </section>
      <section className="panel">
        <h2>Projects</h2>
        {query.data.projects.length ? (
          <ul className="link-list">
            {query.data.projects.map((project) => (
              <li key={project.project_id}>
                <Link to={`/projects/${project.project_id}`}>{project.display_name}</Link>
                <StatusBadge status={project.available ? 'available' : 'unavailable'} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No projects reported.</Empty>
        )}
      </section>
    </>
  );
}

export function ProjectsPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const query = useQuery({
    queryKey: scopedKey(org, 'projects'),
    queryFn: () => apiRequest<{ projects: ProjectRecord[] }>('/api/v1/projects'),
  });
  if (query.isPending) return <Loading label="Loading projects" />;
  if (query.error) return <ErrorNotice error={query.error} />;
  return (
    <>
      <PageHeader
        title="Projects"
        description="Isolated agent runtime trust domains."
        actions={
          // Hidden for a role that cannot create one, but the server is what
          // enforces it: this only avoids offering a form that always fails.
          session.permissions.includes('project.manage') ? (
            <Link className="button primary" to="/projects/new">
              New project
            </Link>
          ) : null
        }
      />
      {query.data.projects.length === 0 ? (
        <Empty>No projects are registered.</Empty>
      ) : (
        <div className="card-grid">
          {query.data.projects.map((project) => (
            <Link
              className="resource-card"
              // Keyed by the durable id, never by position or slug: a refresh
              // that reordered the list would otherwise duplicate a card.
              to={`/projects/${project.project_id}`}
              key={project.project_id}
            >
              <div>
                <h2>{project.display_name}</h2>
                {/* A project migrated before provisioning existed has no state
                    and was already running, so it reads as ready. */}
                <StatusBadge status={project.provisioning_state ?? 'ready'} />
              </div>
              <dl>
                <dt>Node project</dt>
                <dd>{project.node_project_id}</dd>
                <dt>Last activity</dt>
                <dd>{formatTime(project.last_seen_at)}</dd>
              </dl>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Creating a project.
 *
 * The form's job is to be truthful about what happens next: the server accepts
 * a request, a Node builds something, and neither is instant. Nothing here
 * pretends the project is usable until the Node says a worker answered.
 */
export function NewProjectPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const navigate = useNavigate();
  const client = useQueryClient();

  const nodes = useQuery({
    queryKey: scopedKey(org, 'nodes'),
    queryFn: () => apiRequest<{ nodes: NodeRecord[] }>('/api/v1/nodes'),
  });

  const [values, setValues] = useState<FormValues>({
    name: '',
    slug: '',
    nodeId: '',
    mode: 'empty',
    repositoryUrl: '',
    branch: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  // The slug follows the name only until the operator edits it themselves.
  const [slugTouched, setSlugTouched] = useState(false);

  const selectable = useMemo(
    () => (nodes.data?.nodes ?? []).filter(nodeIsSelectable),
    [nodes.data],
  );
  const selectedNode = (nodes.data?.nodes ?? []).find((node) => node.node_id === values.nodeId);
  const modes = selectedNode?.node_capabilities?.workspace_modes ?? ['empty'];

  // One compatible Node is not a choice; asking for it would be ceremony.
  const soleNode = selectable.length === 1 ? selectable[0]!.node_id : '';
  if (soleNode && !values.nodeId) {
    setValues((current) => ({ ...current, nodeId: soleNode }));
  }

  const update = (patch: Partial<FormValues>) => {
    setValues((current) => {
      const next = { ...current, ...patch };
      if (patch.name !== undefined && !slugTouched) next.slug = suggestSlug(patch.name);
      return next;
    });
  };

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiRequest<{ project: ProvisionedProject }>('/api/v1/projects', {
        method: 'POST',
        ...jsonBody(payload),
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: scopedKey(org, 'projects') });
      // Straight to the project's own surface, which shows what the Node is
      // doing. Chat is not opened: nothing can run yet.
      navigate(`/projects/${result.project.project_id}`);
    },
    onError: (error) => {
      setServerError(error instanceof ApiError ? error.code : null);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    setServerError(null);
    const found = validate(values, modes);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Focus follows the first problem rather than leaving the operator to
      // hunt for it.
      const field = document.getElementById(`field-${Object.keys(found)[0]}`);
      field?.focus();
      return;
    }
    create.mutate(buildCreatePayload(values));
  };

  if (nodes.isPending) return <Loading label="Loading nodes" />;
  if (nodes.error) return <ErrorNotice error={nodes.error} />;

  return (
    <>
      <PageHeader
        title="New project"
        description="A project gets its own workspace and its own isolated agent runtime on one Node."
      />
      {selectable.length === 0 ? (
        <Empty>
          No connected Node can host a new project yet. A Node must be online and running a build
          that supports multiple projects.
        </Empty>
      ) : (
        <form className="panel form" onSubmit={submit} noValidate>
          {serverError ? (
            <p className="notice" role="alert">
              {failureMessage(serverError)}
            </p>
          ) : null}

          <label htmlFor="field-name">Project name</label>
          <input
            id="field-name"
            name="name"
            autoComplete="off"
            maxLength={200}
            value={values.name}
            disabled={create.isPending}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? 'error-name' : undefined}
            onChange={(event) => update({ name: event.target.value })}
          />
          {errors.name ? (
            <p className="field-error" id="error-name">
              {errors.name}
            </p>
          ) : null}

          <label htmlFor="field-slug">Identifier</label>
          <input
            id="field-slug"
            name="slug"
            autoComplete="off"
            maxLength={80}
            value={values.slug}
            disabled={create.isPending}
            aria-invalid={errors.slug ? true : undefined}
            aria-describedby={errors.slug ? 'error-slug' : 'hint-slug'}
            onChange={(event) => {
              setSlugTouched(true);
              update({ slug: event.target.value });
            }}
          />
          <p className="field-hint" id="hint-slug">
            Lowercase letters, numbers and dashes. Used to refer to the project.
          </p>
          {errors.slug ? (
            <p className="field-error" id="error-slug">
              {errors.slug}
            </p>
          ) : null}

          <label htmlFor="field-nodeId">Node</label>
          <select
            id="field-nodeId"
            name="nodeId"
            value={values.nodeId}
            disabled={create.isPending}
            aria-invalid={errors.nodeId ? true : undefined}
            onChange={(event) => update({ nodeId: event.target.value })}
          >
            <option value="">Choose a Node</option>
            {(nodes.data?.nodes ?? []).map((node) => {
              const reason = nodeUnavailableReason(node);
              return (
                <option key={node.node_id} value={node.node_id} disabled={reason !== null}>
                  {/* The reason travels with the option, so a disabled entry
                      explains itself instead of just refusing. */}
                  {node.display_name}
                  {reason ? ` — ${reason}` : ''}
                </option>
              );
            })}
          </select>
          {errors.nodeId ? <p className="field-error">{errors.nodeId}</p> : null}

          <fieldset>
            <legend>Workspace</legend>
            <label className="choice">
              <input
                type="radio"
                name="mode"
                value="empty"
                checked={values.mode === 'empty'}
                disabled={create.isPending}
                onChange={() => update({ mode: 'empty' as WorkspaceMode })}
              />
              Create an empty repository
            </label>
            <label className="choice">
              <input
                type="radio"
                name="mode"
                value="clone"
                checked={values.mode === 'clone'}
                disabled={create.isPending || !modes.includes('clone')}
                onChange={() => update({ mode: 'clone' as WorkspaceMode })}
              />
              Clone an existing Git repository
            </label>
          </fieldset>

          {values.mode === 'clone' ? (
            <>
              <label htmlFor="field-repositoryUrl">Repository address</label>
              <input
                id="field-repositoryUrl"
                name="repositoryUrl"
                autoComplete="off"
                maxLength={600}
                value={values.repositoryUrl}
                disabled={create.isPending}
                aria-invalid={errors.repositoryUrl ? true : undefined}
                aria-describedby={errors.repositoryUrl ? 'error-repo' : 'hint-repo'}
                onChange={(event) => update({ repositoryUrl: event.target.value })}
              />
              <p className="field-hint" id="hint-repo">
                The Node clones with the Git credentials already set up on the server. Do not put a
                password or token in the address.
              </p>
              {errors.repositoryUrl ? (
                <p className="field-error" id="error-repo">
                  {errors.repositoryUrl}
                </p>
              ) : null}

              <label htmlFor="field-branch">Branch (optional)</label>
              <input
                id="field-branch"
                name="branch"
                autoComplete="off"
                maxLength={300}
                value={values.branch}
                disabled={create.isPending}
                aria-invalid={errors.branch ? true : undefined}
                onChange={(event) => update({ branch: event.target.value })}
              />
              {errors.branch ? <p className="field-error">{errors.branch}</p> : null}
            </>
          ) : null}

          <div className="button-row">
            <button className="button primary" type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create project'}
            </button>
            <Link className="button" to="/projects">
              Cancel
            </Link>
          </div>
        </form>
      )}
    </>
  );
}

/**
 * What a project is doing before it can be used.
 *
 * Deliberately says nothing about where anything lives: the workspace path, the
 * runtime home, the port and the unit are the Node's business and never reach
 * the browser at all.
 */
function ProvisioningPanel({
  project,
  onRetry,
  retrying,
}: {
  project: ProvisionedProject;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { state, failure, retryable } = project.provisioning;
  return (
    <article className="panel">
      <h2>Provisioning</h2>
      {/* Announced, because the transition happens while the operator waits
          and watches rather than acts. */}
      <p aria-live="polite">
        <StatusBadge status={state} /> {stateSummary(state)}
      </p>
      {state === 'failed' ? (
        <>
          <p className="notice">{failureMessage(failure)}</p>
          {retryable ? (
            <button className="button" type="button" onClick={onRetry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Retry provisioning'}
            </button>
          ) : (
            <p className="muted">
              Trying again will not change this. Correct the project settings or ask an operator.
            </p>
          )}
        </>
      ) : null}
      {state === 'ready' ? <p className="muted">This project is ready to use.</p> : null}
    </article>
  );
}

export function ProjectDetailPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const { projectId = '' } = useParams();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: scopedKey(org, 'project', projectId),
    queryFn: () =>
      apiRequest<{
        project: ProvisionedProject;
        node: NodeRecord;
        active_run: RunRecord | null;
        recent_runs: RunRecord[];
      }>(`/api/v1/projects/${encodeURIComponent(projectId)}`),
    // Asked again only while the answer can still change, and never after a
    // terminal state. There is no second stream for this: one bounded poll of
    // the same GET is what a reload would do anyway.
    refetchInterval: (current) => {
      const state = current.state.data?.project.provisioning?.state;
      return state && isSettling(state) ? 2_000 : false;
    },
  });

  const retry = useMutation({
    mutationFn: () =>
      apiRequest<{ project: ProvisionedProject }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/provisioning/retry`,
        { method: 'POST' },
      ),
    // The server's answer replaces what is shown; nothing is guessed locally,
    // and the poll resumes because the returned state is settling again.
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: scopedKey(org, 'project', projectId) }),
  });

  if (query.isPending) return <Loading label="Loading project" />;
  if (query.error) return <ErrorNotice error={query.error} />;

  const project = query.data.project;
  // A project migrated before provisioning existed carries no state and was
  // already running, so it reads as ready rather than as unbuilt.
  const state = project.provisioning?.state ?? 'ready';
  const runnable = state === 'ready';

  return (
    <>
      <PageHeader title={project.name} description={`Runs on ${query.data.node.display_name}`} />
      {runnable ? null : (
        <ProvisioningPanel
          project={project}
          onRetry={() => {
            if (!retry.isPending) retry.mutate();
          }}
          retrying={retry.isPending}
        />
      )}
      {retry.error ? (
        <p className="notice" role="alert">
          {failureMessage(retry.error instanceof ApiError ? retry.error.code : null)}
        </p>
      ) : null}
      <section className="detail-grid">
        <article className="panel">
          <h2>Runtime</h2>
          <dl className="facts">
            <dt>State</dt>
            <dd>
              <StatusBadge status={state} />
            </dd>
            <dt>Workspace</dt>
            <dd>{project.workspace ? project.workspace.mode : 'existing'}</dd>
            <dt>Node</dt>
            <dd>
              <Link to={`/nodes/${query.data.node.node_id}`}>{query.data.node.display_name}</Link>
            </dd>
          </dl>
        </article>
        <article className="panel">
          <h2>Active run</h2>
          {query.data.active_run ? (
            <RunTable runs={[query.data.active_run]} />
          ) : (
            <Empty>Project is idle.</Empty>
          )}
        </article>
      </section>
      {runnable ? (
        <ProjectChat
          projectId={projectId}
          organizationId={org ?? ''}
          permissions={session.permissions}
          userId={session.user.user_id}
          projectAvailable={project.available}
        />
      ) : null}
    </>
  );
}

export function RunsPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const [status, setStatus] = useState('');
  const query = useQuery({
    queryKey: scopedKey(org, 'runs', status),
    queryFn: () =>
      apiRequest<{ runs: RunRecord[] }>(
        `/api/v1/runs${status ? `?status=${encodeURIComponent(status)}` : ''}`,
      ),
  });
  return (
    <>
      <PageHeader
        title="Runs"
        description="Durable organization run history."
        actions={
          <label className="inline-field">
            Status{' '}
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All</option>
              {[
                'queued',
                'running',
                'waiting_for_approval',
                'completed',
                'failed',
                'cancelled',
                'interrupted',
                'lost',
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        }
      />
      {query.isPending ? (
        <Loading label="Loading runs" />
      ) : query.error ? (
        <ErrorNotice error={query.error} />
      ) : query.data.runs.length ? (
        <RunTable runs={query.data.runs} />
      ) : (
        <Empty>No runs match this filter.</Empty>
      )}
    </>
  );
}

export function RunDetailPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const { runId = '' } = useParams();
  const client = useQueryClient();
  const navigate = useNavigate();
  const run = useQuery({
    queryKey: scopedKey(org, 'run', runId),
    queryFn: () => apiRequest<{ run: RunRecord }>(`/api/v1/runs/${encodeURIComponent(runId)}`),
    refetchInterval: 5_000,
  });
  const history = useQuery({
    queryKey: scopedKey(org, 'run-events', runId),
    queryFn: () =>
      apiRequest<{ events: RunEvent[] }>(
        `/api/v1/runs/${encodeURIComponent(runId)}/events?since_seq=0&limit=1000`,
      ),
  });
  const live = useRunEvents(org, runId);
  const action = useMutation({
    mutationFn: ({ path, body = {} }: { path: string; body?: unknown }) =>
      apiRequest<{ run?: RunRecord }>(`/api/v1/runs/${encodeURIComponent(runId)}/${path}`, {
        method: 'POST',
        ...jsonBody(body),
      }),
    onSuccess: (value) => {
      if (value.run) {
        navigate(`/runs/${value.run.run_id}`);
        return;
      }
      void client.invalidateQueries({ queryKey: scopedKey(org, 'run', runId) });
    },
  });
  const events = useMemo(() => {
    const map = new Map<number, RunEvent>();
    for (const event of [...(history.data?.events ?? []), ...live.events])
      map.set(Number(event.seq), event);
    return [...map.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
  }, [history.data, live.events]);
  if (run.isPending) return <Loading label="Loading run" />;
  if (run.error) return <ErrorNotice error={run.error} />;
  const record = run.data.run;
  const canAny = session.permissions.includes('run.manage_any');
  const canOwn =
    session.permissions.includes('run.manage_own') &&
    record.created_by_user_id === session.user.user_id;
  const canManage = canAny || canOwn;
  const assistant = assistantText(events);
  const tools = events.filter((event) => event.event_type.startsWith('tool.'));
  const approval = [...events].reverse().find((event) => event.event_type === 'approval.request');
  const replacementRunId = record.replacement_run_id ?? null;
  const choices = Array.isArray(approval?.payload.choices)
    ? supportedChoices(approval.payload.choices)
    : ['once', 'deny'];
  return (
    <>
      <PageHeader
        title={`Run ${record.run_id.slice(0, 12)}…`}
        description={`Created ${formatTime(record.created_at)}`}
        actions={
          <div className="stream-state" role="status">
            <span className={`stream-dot ${live.state}`} />
            Stream {live.state}
          </div>
        }
      />
      {action.error ? <ErrorNotice error={action.error} /> : null}
      <section className="detail-grid">
        <article className="panel">
          <h2>Status</h2>
          <StatusBadge status={record.status} />
          <dl className="facts">
            <dt>Started</dt>
            <dd>{formatTime(record.started_at)}</dd>
            <dt>Finished</dt>
            <dd>{formatTime(record.finished_at)}</dd>
            <dt>Input size</dt>
            <dd>{record.request_metadata?.input_length ?? 'Unknown'} characters</dd>
            {record.retry_of_run_id ? (
              <>
                <dt>Retry of</dt>
                <dd>
                  <Link to={`/runs/${record.retry_of_run_id}`}>
                    {record.retry_of_run_id.slice(0, 12)}…
                  </Link>
                </dd>
              </>
            ) : null}
            {replacementRunId ? (
              <>
                <dt>Retried as</dt>
                <dd>
                  <Link to={`/runs/${replacementRunId}`}>{replacementRunId.slice(0, 12)}…</Link>
                </dd>
              </>
            ) : null}
          </dl>
        </article>
        <article className="panel">
          <h2>Actions</h2>
          <div className="button-row">
            {canManage &&
            ['running', 'waiting_for_approval', 'recovering'].includes(record.status) ? (
              <ConfirmButton
                danger
                label="Cancel run"
                confirmLabel="Cancel run"
                description="A cancellation command will be sent to the Node."
                disabled={action.isPending}
                onConfirm={() => action.mutate({ path: 'cancel' })}
              />
            ) : null}
            {canManage && ['interrupted', 'lost'].includes(record.status) ? (
              <button
                className="button"
                disabled={action.isPending}
                onClick={() => action.mutate({ path: 'retry' })}
              >
                Retry
              </button>
            ) : null}
          </div>
          {!canManage ? <p className="muted">Your role cannot mutate this run.</p> : null}
        </article>
      </section>
      {record.status === 'waiting_for_approval' && approval && canManage ? (
        <section className="panel approval">
          <h2>Approval required</h2>
          <p>
            {typeof approval.payload.description === 'string'
              ? approval.payload.description
              : 'The agent requested permission to continue.'}
          </p>
          <div className="button-row">
            {choices.map((choice) => (
              <button
                className={choice === 'deny' ? 'button danger' : 'button primary'}
                key={choice}
                disabled={action.isPending}
                onClick={() => action.mutate({ path: 'approval', body: { choice } })}
              >
                {choice === 'deny' ? 'Deny' : `Approve ${choice}`}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {/* A run that ended badly is exactly the one an operator opens this page
          for, and "no assistant output" is not a reason. */}
      {record.error_message || record.error_code ? (
        <section className="panel">
          <h2>Why it ended</h2>
          {record.error_message ? <p className="notice">{record.error_message}</p> : null}
          {record.error_code ? <p className="mono-small">{record.error_code}</p> : null}
        </section>
      ) : null}
      <section className="panel output">
        <h2>Assistant output</h2>
        {assistant ? <pre>{assistant}</pre> : <Empty>No assistant output yet.</Empty>}
      </section>
      <section className="detail-grid">
        <article className="panel">
          <h2>Tool activity</h2>
          {tools.length ? (
            <ol className="timeline">
              {tools.map((event) => (
                <li key={String(event.seq)}>
                  <StatusBadge status={event.event_type} />
                  {/* The runtime names the tool in `tool`; without it this list
                      is a column of identical badges. */}
                  <span className="mono-small">
                    {typeof event.payload?.tool === 'string' ? event.payload.tool : 'unnamed tool'}
                  </span>
                  {/* The runtime already reports what was run — the command, the
                      file, the search pattern — on the `started` event. Without
                      it this page said only that a tool ran and possibly failed,
                      which is not enough to act on. */}
                  {typeof event.payload?.preview === 'string' && event.payload.preview.trim() ? (
                    <span className="mono-small tool-preview" title={event.payload.preview}>
                      {event.payload.preview.length > 160
                        ? `${event.payload.preview.slice(0, 160)}…`
                        : event.payload.preview}
                    </span>
                  ) : null}
                  {event.payload?.error === true ? <span className="badge">failed</span> : null}
                  {typeof event.payload?.duration === 'number' ? (
                    <span className="muted mono-small">{event.payload.duration.toFixed(1)}s</span>
                  ) : null}
                  <time>{formatTime(event.recorded_at ?? event.ingested_at)}</time>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>No tool activity.</Empty>
          )}
        </article>
        <article className="panel">
          <h2>Reasoning</h2>
          {events.some((event) => event.event_type === 'reasoning.available') ? (
            <p>
              The runtime signalled reasoning for this run. It arrives after the answer and restates
              it, so it is not shown as a separate turn; the model&rsquo;s own hidden reasoning is
              never exposed. The raw event is in the timeline below.
            </p>
          ) : (
            <p className="muted">No reasoning availability signal.</p>
          )}
        </article>
      </section>
      <section className="panel">
        <h2>Event timeline</h2>
        {history.isPending ? (
          <Loading label="Loading event history" />
        ) : (
          <ol className="timeline event-timeline">
            {events.map((event) => (
              <li key={String(event.seq)}>
                <span className="sequence">#{event.seq}</span>
                <StatusBadge status={event.event_type} />
                <time>{formatTime(event.recorded_at ?? event.ingested_at)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

export function MembersPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationSummary['role']>('developer');
  const [invitationUrl, setInvitationUrl] = useState('');
  const members = useQuery({
    queryKey: scopedKey(org, 'members'),
    queryFn: () => apiRequest<{ members: MemberRecord[] }>('/api/v1/members'),
  });
  const invitations = useQuery({
    queryKey: scopedKey(org, 'invitations'),
    queryFn: () => apiRequest<{ invitations: InvitationRecord[] }>('/api/v1/invitations'),
  });
  const invite = useMutation({
    mutationFn: () =>
      apiRequest<{ invitation_url: string }>('/api/v1/invitations', {
        method: 'POST',
        ...jsonBody({ email, role }),
      }),
    onSuccess: (value) => {
      setInvitationUrl(value.invitation_url);
      setEmail('');
      void client.invalidateQueries({ queryKey: scopedKey(org, 'invitations') });
    },
  });
  const disable = useMutation({
    mutationFn: (userId: string) => apiRequest(`/api/v1/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: scopedKey(org, 'members') }),
  });
  if (members.isPending || invitations.isPending) return <Loading label="Loading members" />;
  if (members.error || invitations.error)
    return <ErrorNotice error={members.error ?? invitations.error} />;
  const canManage = session.permissions.includes('member.manage');
  const canInvite = session.permissions.includes('invitation.manage');
  return (
    <>
      <PageHeader
        title="Members and invitations"
        description="Organization access and role assignments."
      />
      {canInvite ? (
        <section className="panel">
          <h2>Invite member</h2>
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              invite.mutate();
            }}
          >
            <label>
              Email
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Role
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as OrganizationSummary['role'])}
              >
                {[
                  'admin',
                  'developer',
                  'viewer',
                  ...(session.permissions.includes('member.grant_owner') ? ['owner'] : []),
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button className="button primary" disabled={invite.isPending}>
              Create invitation
            </button>
          </form>
          {invitationUrl ? (
            <div className="notice success" role="status">
              <strong>Invitation URL (shown once)</strong>
              <code>{invitationUrl}</code>
            </div>
          ) : null}
          {invite.error ? <ErrorNotice error={invite.error} /> : null}
        </section>
      ) : null}
      <section className="panel">
        <h2>Members</h2>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Organization members</caption>
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.data.members.map((member) => (
                <tr key={member.user_id}>
                  <td>
                    <strong>{member.display_name}</strong>
                    <small className="block">{member.email}</small>
                  </td>
                  <td>{member.role}</td>
                  <td>
                    <StatusBadge
                      status={
                        member.disabled_at ? 'disabled' : member.enabled ? 'active' : 'disabled'
                      }
                    />
                  </td>
                  <td>
                    {canManage && !member.disabled_at ? (
                      <ConfirmButton
                        danger
                        label="Disable"
                        confirmLabel="Disable membership"
                        description={`Disable ${member.display_name}'s organization membership immediately.`}
                        onConfirm={() => disable.mutate(member.user_id)}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Invitations</h2>
        {invitations.data.invitations.length ? (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Invitations</caption>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Expires</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {invitations.data.invitations.map((item) => (
                  <tr key={item.invitation_id}>
                    <td>{item.email}</td>
                    <td>{item.intended_role}</td>
                    <td>{formatTime(item.expires_at)}</td>
                    <td>
                      <StatusBadge
                        status={
                          item.accepted_at ? 'accepted' : item.revoked_at ? 'revoked' : 'pending'
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No invitations.</Empty>
        )}
      </section>
    </>
  );
}

export function AuditPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const [action, setAction] = useState('');
  const query = useQuery({
    queryKey: scopedKey(org, 'audit', action),
    queryFn: () =>
      apiRequest<{ entries: AuditRecord[] }>(
        `/api/v1/audit${action ? `?action=${encodeURIComponent(action)}` : ''}`,
      ),
  });
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Immutable security-relevant organization history."
        actions={
          <label className="inline-field">
            Action{' '}
            <input
              value={action}
              onChange={(event) => setAction(event.target.value)}
              placeholder="run.create"
            />
          </label>
        }
      />
      {query.isPending ? (
        <Loading label="Loading audit" />
      ) : query.error ? (
        <ErrorNotice error={query.error} />
      ) : query.data.entries.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Audit entries</caption>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Result</th>
                <th>Correlation</th>
              </tr>
            </thead>
            <tbody>
              {query.data.entries.map((entry) => (
                <tr key={entry.audit_id}>
                  <td>{formatTime(entry.occurred_at)}</td>
                  <td>{entry.actor}</td>
                  <td>
                    <code>{entry.action}</code>
                  </td>
                  <td>
                    {entry.target_type ?? '—'} {entry.target_id?.slice(0, 12) ?? ''}
                  </td>
                  <td>
                    <StatusBadge status={entry.result} />
                  </td>
                  <td className="mono-small">{entry.correlation_id?.slice(0, 12) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No audit entries match this filter.</Empty>
      )}
    </>
  );
}
