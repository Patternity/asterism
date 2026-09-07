import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';

import { apiRequest, scopedKey } from './api';
import { useConsoleView } from './console-view';
import type { NodeRecord, ProjectRecord, SessionResponse } from './types';

function connectionLabel(state: string) {
  return state === 'online' ? 'connected' : state.replaceAll('_', ' ');
}

export function ConversationLayout({ session }: { session: SessionResponse }) {
  const { setView } = useConsoleView();
  const location = useLocation();
  const organizationId = session.active_organization!.organization_id;
  const nodes = useQuery({
    queryKey: scopedKey(organizationId, 'nodes'),
    queryFn: () => apiRequest<{ nodes: NodeRecord[] }>('/api/v1/nodes'),
  });
  const projects = useQuery({
    queryKey: scopedKey(organizationId, 'projects'),
    queryFn: () => apiRequest<{ projects: ProjectRecord[] }>('/api/v1/projects'),
  });
  const projectMatch = /^\/projects\/([^/]+)$/.exec(location.pathname);
  const selectedProject = projects.data?.projects.find(
    (project) => project.project_id === projectMatch?.[1],
  );
  const selectedNode = nodes.data?.nodes.find((node) => node.node_id === selectedProject?.node_id);
  const canManageNodes = session.permissions.includes('node.manage');
  const canManageProjects = session.permissions.includes('project.manage');

  return (
    <div className="conversation-shell">
      <aside className="conversation-sidebar">
        <div className="conversation-brand">
          <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
          <div>
            <strong>Asterism</strong>
            <small>Operations</small>
          </div>
        </div>

        <button className="view-switch conversation-view-switch" onClick={() => setView('classic')}>
          Use classic view
        </button>

        <div className="tree-heading">
          <span>Nodes</span>
          {canManageNodes ? (
            <Link
              to="/nodes/add"
              aria-label="Add Node"
              title="Add Node"
              onClick={() => setView('classic')}
            >
              +
            </Link>
          ) : null}
        </div>

        {nodes.isPending || projects.isPending ? (
          <div className="tree-message" role="status">
            Loading Nodes and projects…
          </div>
        ) : nodes.error || projects.error ? (
          <div className="tree-message" role="alert">
            {nodes.error instanceof Error
              ? nodes.error.message
              : projects.error instanceof Error
                ? projects.error.message
                : 'The Node and project tree could not be loaded.'}
          </div>
        ) : nodes.data.nodes.length === 0 ? (
          <div className="tree-message">No Nodes are enrolled.</div>
        ) : (
          <nav className="node-tree" aria-label="Nodes and projects">
            {nodes.data.nodes.map((node) => {
              const children = projects.data.projects.filter(
                (project) => project.node_id === node.node_id,
              );
              return (
                <section className="tree-node" key={node.node_id}>
                  <div className="tree-node-row">
                    <span
                      className={`connection-dot connection-${node.connection_state}`}
                      aria-label={connectionLabel(node.connection_state)}
                    />
                    <strong>{node.display_name}</strong>
                    <span className="tree-node-state">
                      {connectionLabel(node.connection_state)}
                    </span>
                    {canManageProjects ? (
                      <Link
                        className="tree-add-project"
                        to={`/projects/new?node=${encodeURIComponent(node.node_id)}`}
                        aria-label={`Add project to ${node.display_name}`}
                        title={`Add project to ${node.display_name}`}
                        onClick={() => setView('classic')}
                      >
                        +
                      </Link>
                    ) : null}
                  </div>
                  {children.length > 0 ? (
                    <div className="tree-projects">
                      {children.map((project) => (
                        <NavLink key={project.project_id} to={`/projects/${project.project_id}`}>
                          <span className="project-glyph" aria-hidden="true">
                            ◇
                          </span>
                          <span>{project.display_name}</span>
                          {!project.available ? <small>unavailable</small> : null}
                        </NavLink>
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </nav>
        )}

        <div className="conversation-identity">
          <span>{session.user.display_name}</span>
          <small>{session.active_organization?.display_name}</small>
        </div>
      </aside>

      <main className="conversation-content" id="main-content">
        {projectMatch ? (
          <Outlet context={session} />
        ) : (
          <section className="conversation-welcome" aria-labelledby="conversation-welcome-title">
            <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
            <h1 id="conversation-welcome-title">Choose a project</h1>
            <p>
              This draft view covers the Node and project tree and project conversations. Overview,
              Node details, project creation, runs, members, audit, organization switching, and
              sign-out remain in the classic view.
            </p>
          </section>
        )}
        {selectedNode ? (
          <footer className="conversation-connection">
            <span
              className={`connection-dot connection-${selectedNode.connection_state}`}
              aria-hidden="true"
            />
            {selectedNode.display_name} {connectionLabel(selectedNode.connection_state)}
          </footer>
        ) : null}
      </main>
    </div>
  );
}
