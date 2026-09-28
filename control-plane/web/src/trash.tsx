import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';

import { apiRequest, jsonBody, scopedKey } from './api';
import { ConfirmButton, Empty, ErrorNotice, Loading, PageHeader, StatusBadge } from './components';
import {
  TRASH_NODE_CONFIRMATION,
  TRASH_PROJECT_CONFIRMATION,
  projectRestore,
  projectTrashReason,
  workerLabel,
  workerTone,
  type TrashTreeNode,
} from './trash-view';
import type { SessionResponse } from './types';

/** The same accessors the other pages use, so scoping cannot diverge. */
function useProductSession(): SessionResponse {
  return useOutletContext<SessionResponse>();
}

function organizationId(session: SessionResponse): string {
  if (!session.active_organization) throw new Error('active organization is required');
  return session.active_organization.organization_id;
}

/**
 * Moving something in or out of Trash changes what every ordinary view shows,
 * so every view is asked again once the action is answered. Nothing is
 * predicted locally: the Control Plane's answer is what the pages draw.
 */
function useLifecycleRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries();
}

function useLifecycle(path: string) {
  const refresh = useLifecycleRefresh();
  return useMutation({
    mutationFn: () =>
      apiRequest<Record<string, unknown>>(path, { method: 'POST', ...jsonBody({}) }),
    // Started, not awaited. Returning the refresh here kept the mutation
    // pending until every view had refetched, so the button stayed disabled and
    // the page did not move for as long as the slowest query took -- half a
    // minute against a real Control Plane, which reads as frozen.
    onSuccess: () => {
      void refresh();
    },
  });
}

/** Move one project to Trash, from its own page. */
export function TrashProjectButton({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const trash = useLifecycle(`/api/v1/projects/${encodeURIComponent(projectId)}/trash`);
  return (
    <>
      <ConfirmButton
        danger
        label="Move to Trash"
        confirmLabel="Move project to Trash"
        description={TRASH_PROJECT_CONFIRMATION}
        disabled={trash.isPending}
        onConfirm={() => trash.mutate(undefined, { onSuccess: () => navigate('/trash') })}
      />
      {trash.error ? <ErrorNotice error={trash.error} /> : null}
    </>
  );
}

/** Move one Node and its whole branch to Trash, from its own page. */
export function TrashNodeButton({ nodeId }: { nodeId: string }) {
  const navigate = useNavigate();
  const trash = useLifecycle(`/api/v1/nodes/${encodeURIComponent(nodeId)}/trash`);
  return (
    <>
      <ConfirmButton
        danger
        label="Move to Trash"
        confirmLabel="Move Node to Trash"
        description={TRASH_NODE_CONFIRMATION}
        disabled={trash.isPending}
        onConfirm={() => trash.mutate(undefined, { onSuccess: () => navigate('/trash') })}
      />
      {trash.error ? <ErrorNotice error={trash.error} /> : null}
    </>
  );
}

function RestoreButton({ path, label }: { path: string; label: string }) {
  const restore = useLifecycle(path);
  return (
    <span className="button-row">
      <button
        className="button secondary"
        type="button"
        disabled={restore.isPending}
        onClick={() => restore.mutate()}
      >
        {restore.isPending ? 'Restoring…' : label}
      </button>
      {restore.error ? <ErrorNotice error={restore.error} /> : null}
    </span>
  );
}

/**
 * Trash, as one tree: Nodes, and the projects under each.
 *
 * A Node in Trash carries every project on it. An active Node appears only as
 * the context for projects somebody put in Trash on their own, so a project is
 * always shown under the Node it belongs to. Restore is offered where it means
 * something: on a Node in Trash, and on a project in Trash on its own under an
 * active Node.
 */
export function TrashPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const query = useQuery({
    queryKey: scopedKey(org, 'trash'),
    queryFn: () => apiRequest<{ nodes: TrashTreeNode[] }>('/api/v1/trash'),
    // Asked again only while a worker is still on its way somewhere, so the
    // row can say when it got there.
    refetchInterval: (current) =>
      current.state.data?.nodes.some((node) =>
        node.projects.some(
          (project) => project.trash.worker === 'stopping' || project.trash.worker === 'starting',
        ),
      )
        ? 2_000
        : false,
  });
  if (query.isPending) return <Loading label="Loading Trash" />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const nodes = query.data.nodes;
  return (
    <>
      <PageHeader
        title="Trash"
        description="Nodes and projects moved out of sight. Everything here is kept and can be restored; nothing is deleted from any host."
      />
      {nodes.length === 0 ? <Empty>Trash is empty.</Empty> : null}
      {nodes.map((node) => (
        <article className="panel" key={node.node_id} aria-label={`Node ${node.display_name}`}>
          <h2>
            <Link to={`/nodes/${encodeURIComponent(node.node_id)}`}>{node.display_name}</Link>
          </h2>
          <p>
            {node.role === 'trashed' ? (
              <>
                <StatusBadge status="warn" /> In Trash, with every project on it.
              </>
            ) : (
              <>
                <StatusBadge status="ok" /> Active. Shown here only for the projects below.
              </>
            )}
          </p>
          {node.role === 'trashed' ? (
            <RestoreButton
              path={`/api/v1/nodes/${encodeURIComponent(node.node_id)}/restore`}
              label="Restore Node"
            />
          ) : null}
          <ul className="trash-branch">
            {node.projects.map((project) => {
              const restore = projectRestore(project.trash);
              const worker = workerLabel(project.trash.worker);
              return (
                <li key={project.project_id}>
                  <Link to={`/projects/${encodeURIComponent(project.project_id)}`}>
                    {project.display_name}
                  </Link>{' '}
                  <span className="muted">{projectTrashReason(project.trash)}</span>
                  {worker ? (
                    <p>
                      <StatusBadge status={workerTone(project.trash.worker)} /> {worker}
                    </p>
                  ) : null}
                  {restore.offered ? (
                    <RestoreButton
                      path={`/api/v1/projects/${encodeURIComponent(project.project_id)}/restore`}
                      label="Restore project"
                    />
                  ) : restore.reason ? (
                    <p className="muted">{restore.reason}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </article>
      ))}
    </>
  );
}

/** A notice for a page reached by exact id while its subject is in Trash. */
export function InTrashNotice({
  what,
  restorePath,
  reason,
}: {
  what: 'project' | 'Node';
  restorePath: string | null;
  reason: string;
}) {
  return (
    <p className="notice" role="status">
      This {what} is in Trash. {reason}{' '}
      {restorePath ? <RestoreButton path={restorePath} label={`Restore ${what}`} /> : null}{' '}
      <Link to="/trash">Open Trash</Link>
    </p>
  );
}
