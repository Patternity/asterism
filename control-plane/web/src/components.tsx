import type { ReactNode } from 'react';
import { useState } from 'react';
import { NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';

import { ApiError } from './api';
import { useLogout, useOrganizations, useSelectOrganization, useSession } from './auth';

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}…
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'The request could not be completed.';
  return (
    <div className="notice error" role="alert">
      {message}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge status-${status.replaceAll('_', '-')}`}>
      {status.replaceAll('_', ' ')}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function ConfirmButton({
  label,
  confirmLabel,
  description,
  danger = false,
  disabled = false,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  description: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={danger ? 'button danger' : 'button'}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open ? (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-description"
          >
            <h2 id="confirm-title">Confirm action</h2>
            <p id="confirm-description">{description}</p>
            <div className="dialog-actions">
              <button className="button secondary" onClick={() => setOpen(false)} autoFocus>
                Keep unchanged
              </button>
              <button
                className={danger ? 'button danger' : 'button'}
                onClick={() => {
                  setOpen(false);
                  onConfirm();
                }}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function ProtectedLayout() {
  const session = useSession();
  const organizations = useOrganizations();
  const selectOrganization = useSelectOrganization();
  const logout = useLogout();
  const navigate = useNavigate();

  if (session.isPending) return <Loading label="Loading session" />;
  if (session.error instanceof ApiError && session.error.status === 401) {
    return <Navigate to="/login" replace />;
  }
  if (session.error || !session.data) return <ErrorNotice error={session.error} />;
  if (!session.data.active_organization) return <Navigate to="/select-organization" replace />;

  const active = session.data.active_organization;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✦
          </span>
          <div>
            <strong>Asterism</strong>
            <small>Operations</small>
          </div>
        </div>
        <nav aria-label="Primary navigation">
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/nodes">Nodes</NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/runs">Runs</NavLink>
          {session.data.permissions.includes('member.read') ? (
            <NavLink to="/members">Members</NavLink>
          ) : null}
          {session.data.permissions.includes('audit.read') ? (
            <NavLink to="/audit">Audit</NavLink>
          ) : null}
        </nav>
        <div className="sidebar-footer">
          <label htmlFor="organization">Organization</label>
          <select
            id="organization"
            value={active.organization_id}
            disabled={selectOrganization.isPending}
            onChange={(event) =>
              selectOrganization.mutate(event.target.value, { onSuccess: () => navigate('/') })
            }
          >
            {(organizations.data?.organizations ?? [active]).map((organization) => (
              <option key={organization.organization_id} value={organization.organization_id}>
                {organization.display_name}
              </option>
            ))}
          </select>
          <div className="identity">
            <span>{session.data.user.display_name}</span>
            <small>{active.role}</small>
          </div>
          <button
            className="text-button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="content" id="main-content">
        <Outlet context={session.data} />
      </main>
    </div>
  );
}
