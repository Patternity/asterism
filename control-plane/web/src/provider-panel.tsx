import { useQuery } from '@tanstack/react-query';

import { apiRequest, scopedKey } from './api';
import {
  type ProviderAuthorizationView,
  isProviderState,
  providerLabel,
  sharedPoolExplanation,
} from './provider-authorization';

/**
 * What a Node's shared credential pool is, and what it is not.
 *
 * The pool is what every project without a credential of its own reads. It can
 * hold several accounts, and none of them can be chosen for a project on its
 * own: the runtime picks among them by strategy, not by name. So this panel
 * says whether the pool can serve a run and nothing more. New credentials are
 * never added to it; they are added from the Node's credentials, each kept on
 * its own.
 */
export function ProviderPanel({
  nodeId,
  organizationId,
}: {
  nodeId: string;
  organizationId: string | undefined;
}) {
  const query = useQuery({
    queryKey: scopedKey(organizationId, 'node-provider', nodeId),
    queryFn: () =>
      apiRequest<ProviderAuthorizationView>(
        `/api/v1/nodes/${encodeURIComponent(nodeId)}/provider-authorization`,
      ),
  });

  if (query.isPending || query.isError) return null;
  // A payload this build does not recognise is not rendered at all. The panel is
  // an addition to a page that works without it.
  if (!query.data || !isProviderState(query.data.state)) return null;

  const view = query.data;
  return (
    <article className="panel">
      <h2>Shared credential pool</h2>
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
      <p className="muted">{sharedPoolExplanation(view.state)}</p>
    </article>
  );
}
