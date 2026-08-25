/**
 * Run-scoped approval bypass, shown in the console as
 * "Allow all for this run".
 *
 * It answers every approval that one run emits with `once`. The scope is the
 * point: it ends when the run does, a retry starts back at manual, and nothing
 * is written to Hermes' persistent allowlist. That is what separates it from
 * the `always` grant this deployment refuses outright.
 */
export const RUN_APPROVAL_POLICIES = ['manual', 'allow_all_for_run'] as const;
export type RunApprovalPolicy = (typeof RUN_APPROVAL_POLICIES)[number];

/** Product label for a policy. */
export function policyLabel(policy: RunApprovalPolicy): string {
  return policy === 'allow_all_for_run' ? 'Allow all for this run' : 'Manual approval';
}

/**
 * What the operator is agreeing to. Stated in terms of consequences on this
 * machine rather than as a policy name, because that is what they are deciding.
 */
export const BYPASS_CONFIRMATION =
  'All approval requests emitted during this run will be approved automatically. ' +
  'The agent may modify or delete project data, run Docker commands, and manage ' +
  'services available to the project user on this VPS. The permission ends with this run.';

export const BYPASS_ACTIVE_BANNER = 'Approval bypass enabled for this run';
export const BYPASS_AUDIT_BADGE = 'Approval bypass was enabled';
export const AUTO_RESOLVED_LABEL = 'Auto-approved by run policy';

/**
 * What the Control Plane says this project's Node can do.
 *
 * The console renders from this and nothing else. Inferring support from a
 * version string would produce a control whose command the Node refuses, and
 * showing a control that is certain to fail is worse than not offering it.
 */
export interface NodeCapabilityView {
  connection_status?: string;
  capabilities_known?: boolean;
  run_approval_policy?: string[];
  supports_run_approval_policy?: boolean;
  run_approval_policy_available?: boolean;
  run_attachments?: string[];
  image_attachments_available?: boolean;
}

/**
 * True when the run-scoped control may be rendered.
 *
 * Requires an explicit advertisement *and* a reachable Node: a supported Node
 * that is offline cannot answer the command, and an operator told the bypass is
 * on while nothing enforces it has been misled.
 */
export function canOfferRunPolicy(view: NodeCapabilityView | null | undefined): boolean {
  return Boolean(view?.run_approval_policy_available);
}

/** True when the Node supports it at all, regardless of reachability. */
export function supportsRunApprovalPolicy(view: NodeCapabilityView | null | undefined): boolean {
  return Boolean(view?.supports_run_approval_policy);
}

type PolicyEvent = { event_type?: string; payload?: Record<string, unknown> };

/**
 * The policy a run is under, read from its durable journal.
 *
 * Derived from events rather than held in component state so a browser reload
 * rebuilds the same answer: the banner has to survive a refresh, and the last
 * recorded change is what the Node is actually enforcing.
 */
export function policyFromEvents(events: PolicyEvent[]): {
  policy: RunApprovalPolicy;
  enabledBy: string | null;
  enabledAt: string | null;
} {
  let policy: RunApprovalPolicy = 'manual';
  let enabledBy: string | null = null;
  let enabledAt: string | null = null;

  for (const event of events) {
    if (event.event_type !== 'run.approval_policy.changed') continue;
    const next = event.payload?.policy;
    if (next === 'allow_all_for_run') {
      policy = 'allow_all_for_run';
      enabledBy = typeof event.payload?.actor === 'string' ? event.payload.actor : null;
      enabledAt =
        typeof event.payload?.recorded_at === 'string' ? event.payload.recorded_at : enabledAt;
    } else if (next === 'manual') {
      policy = 'manual';
      enabledBy = null;
      enabledAt = null;
    }
  }
  return { policy, enabledBy, enabledAt };
}

/** True when this run ever had the bypass enabled, for the completed-run badge. */
export function bypassWasEverEnabled(events: PolicyEvent[]): boolean {
  return events.some(
    (event) =>
      event.event_type === 'run.approval_policy.changed' &&
      event.payload?.policy === 'allow_all_for_run',
  );
}

/** Approval sequence numbers the run policy answered without a prompt. */
export function autoResolvedApprovals(events: PolicyEvent[]): Set<number> {
  const seqs = new Set<number>();
  for (const event of events) {
    if (event.event_type !== 'approval.auto_resolved') continue;
    const seq = event.payload?.approval_seq;
    if (typeof seq === 'number') seqs.add(seq);
  }
  return seqs;
}

/**
 * Event types that answer an approval request.
 *
 * `approval.responded` is the runtime confirming it; the other two are how the
 * answer was arrived at — an operator decision relayed by the Control Plane, or
 * the run's own policy resolving it. Any of them ends the wait.
 */
const ANSWERS_APPROVAL = new Set([
  'approval.responded',
  'approval.auto_resolved',
  'asterism.approval.decision',
]);

/**
 * The approval still waiting for an answer, if the journal shows one.
 *
 * Scanning for the last `approval.request` is not enough. A run that asks
 * repeatedly — and answers each one under a bypass policy — leaves a trail of
 * requests that were all resolved; treating the newest as pending puts a dead
 * prompt back on screen, which is what made the bypass button look like it had
 * done nothing. So the walk clears the candidate whenever an answer follows it.
 *
 * Returning `null` does not mean the run is not waiting: the journal window may
 * simply not reach back to the request. The run's own status decides that, and
 * the caller falls back to a description-less prompt rather than hiding it.
 */
export function pendingApproval<T extends PolicyEvent>(events: T[]): T | null {
  let request: T | null = null;
  for (const event of events) {
    const type = event.event_type ?? '';
    if (type === 'approval.request') request = event;
    else if (ANSWERS_APPROVAL.has(type)) request = null;
  }
  return request;
}
