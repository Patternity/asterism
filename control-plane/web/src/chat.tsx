/**
 * Project chat.
 *
 * The product model in one line: **chat is the interaction surface, a run is the
 * durable unit of execution.** One submitted message creates one run; every run
 * in a conversation shares a `session_id`; a retry is another attempt at the
 * same turn rather than a second message.
 *
 * Nothing here holds conversation identity locally. The session and its runs are
 * read from the Control Plane, so a reload — or a different browser — rebuilds
 * the same thread.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { supportedChoices } from './approval-choices';
import {
  MAX_ATTACHMENTS,
  attachmentLabel,
  attachmentProblem,
  attachmentsOf,
  makeAttachment,
  type Attachment,
  describeBytes,
  localImageProblem,
  uploadedAttachmentsOf,
  type LocalImage,
  type UploadedAttachment,
  type UploadLimits,
} from './attachments';
import { describeToolUse, summarizeToolActivity } from './tool-activity';
import {
  AUTO_RESOLVED_LABEL,
  BYPASS_ACTIVE_BANNER,
  BYPASS_AUDIT_BADGE,
  BYPASS_CONFIRMATION,
  autoResolvedApprovals,
  bypassWasEverEnabled,
  canOfferRunPolicy,
  type NodeCapabilityView,
  effectiveRunPolicy,
  pendingApproval,
  policyLabel,
} from './run-policy';
import { apiRequest, jsonBody, scopedKey } from './api';
import { groupTurns, isActive, isTerminal, type ChatRun } from './chat-model';
import { ErrorNotice, Empty, Loading, StatusBadge } from './components';
import { assistantText, reasoningEntries, useRunEvents, type StreamState } from './sse';
import type { RunEvent } from './types';

interface ChatResponse {
  /** Upload availability and the exact limits the composer should enforce. */
  uploads?: UploadLimits;
  session_id: string | null;
  runs: ChatRun[];
  /** What the owning Node advertises. Absent against an older Control Plane. */
  node_capabilities?: NodeCapabilityView;
}

// --------------------------------------------------------------- attempts

/** Everything an attempt renders, once its events are known. */
function AttemptBody({
  run,
  events,
  streamState,
  canManage,
  onAction,
  pending,
  actionError,
  policySupported,
}: {
  run: ChatRun;
  events: RunEvent[];
  streamState?: StreamState;
  canManage: boolean;
  onAction: (path: string, body?: unknown) => void;
  pending: boolean;
  actionError: unknown;
  /** False against a Node too old to honour a run-scoped policy. */
  policySupported: boolean;
}) {
  const text = assistantText(events);
  // One line per tool rather than one per event: the raw journal is on the run
  // detail page, and repeating it here buried the only part worth reading.
  const tools = summarizeToolActivity(events);
  const running = tools.find((use) => use.running);
  // The request still waiting, not merely the most recent one ever made. A run
  // under a bypass policy answers approvals continuously, and showing the last
  // request regardless of its answer put a dead prompt back on screen.
  const approval = pendingApproval(events);
  const choices = Array.isArray(approval?.payload.choices)
    ? supportedChoices(approval.payload.choices)
    : ['once', 'deny'];
  const waiting = run.status === 'waiting_for_approval';
  const deltaCount = events.filter((event) => event.event_type === 'message.delta').length;
  // Read from the durable journal so a reload rebuilds the same state.
  // The server's answer when it sends one; the journal only as a fallback.
  const policyState = effectiveRunPolicy(run, events);
  const autoResolved = autoResolvedApprovals(events);

  return (
    <div className="chat-attempt">
      <div className="chat-attempt-head">
        {/* Under a bypass policy an approval request is answered by the run
            itself, in well under a second, and these arrive back to back — so
            the run spends much of its time momentarily in `waiting_for_approval`
            with nothing actually waiting on a person. Reporting that verbatim
            asks the operator to act on a decision they already made. */}
        <StatusBadge
          status={
            run.status === 'waiting_for_approval' && policyState.policy === 'allow_all_for_run'
              ? 'running'
              : run.status
          }
        />
        {streamState && streamState !== 'complete' && streamState !== 'closed' ? (
          <span className="chat-stream" role="status">
            <span className={`stream-dot ${streamState}`} />
            {streamState === 'reconnecting' ? 'Reconnecting' : 'Streaming'}
          </span>
        ) : null}
        <Link className="mono-small" to={`/runs/${run.run_id}`}>
          Run details
        </Link>
      </div>

      {text ? (
        <div className="chat-message assistant">{text}</div>
      ) : isActive(run) ? (
        <div className="chat-message assistant pending">
          <span className="chat-typing" aria-label="Assistant is working" />
        </div>
      ) : (
        <div className="chat-message assistant muted">No assistant output.</div>
      )}

      {run.error_message ? <p className="notice">{run.error_message}</p> : null}
      {actionError ? <ErrorNotice error={actionError} /> : null}

      {policyState.policy === 'allow_all_for_run' && isActive(run) ? (
        // Derived from the journal, so a reload rebuilds it rather than losing
        // it with component state. Marked as an alert so it is announced, and
        // labelled in words so it does not depend on colour.
        <div className="chat-bypass-banner" role="alert">
          <strong>⚠ {BYPASS_ACTIVE_BANNER}</strong>
          <span className="muted">
            {policyState.enabledBy ? `Enabled by ${policyState.enabledBy}` : 'Enabled'}
            {policyState.enabledAt ? ` at ${policyState.enabledAt}` : ''}
          </span>
          {canManage ? (
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => onAction('approval-policy', { policy: 'manual' })}
            >
              Return to manual approval
            </button>
          ) : null}
        </div>
      ) : null}

      {isActive(run) &&
      !waiting &&
      policyState.policy === 'manual' &&
      policySupported &&
      canManage ? (
        // A run that is working rather than asking still needs this reachable.
        // Offering it only alongside a pending approval meant the control was
        // absent for most of a run's life: an operator who wanted to stop being
        // interrupted had to wait to be interrupted first.
        <div className="chat-bypass-offer">
          <button
            type="button"
            className="button danger"
            disabled={pending}
            onClick={() => {
              if (window.confirm(BYPASS_CONFIRMATION)) {
                onAction('approval-policy', { policy: 'allow_all_for_run' });
              }
            }}
          >
            {policyLabel('allow_all_for_run')}
          </button>
          <span className="muted">Stops this run asking for approval again.</span>
        </div>
      ) : null}

      {isTerminal(run) && bypassWasEverEnabled(events) ? (
        <p className="chat-bypass-badge">⚠ {BYPASS_AUDIT_BADGE}</p>
      ) : null}

      {autoResolved.size > 0 ? (
        <details className="chat-auto-approved">
          <summary>
            {AUTO_RESOLVED_LABEL} ({autoResolved.size})
          </summary>
          <p className="muted">
            Approval requests answered automatically by this run's policy. No operator decision was
            taken for them.
          </p>
        </details>
      ) : null}

      {waiting ? (
        // Visibility follows the run's own status, which is authoritative.
        // Deriving it from the journal instead meant a reload whose event
        // window did not reach back to the request left the run waiting with no
        // way to answer it.
        <div className="chat-approval">
          <h4>
            {policyState.policy === 'allow_all_for_run'
              ? 'Approval requested'
              : 'Approval required'}
          </h4>
          {typeof approval?.payload.description === 'string' ? (
            <p>{approval.payload.description}</p>
          ) : policyState.policy === 'allow_all_for_run' ? null : (
            // Only worth saying when someone is actually being asked.
            <p>The agent is waiting for a decision.</p>
          )}
          {policyState.policy === 'allow_all_for_run' ? (
            // Under a bypass policy the run answers its own approvals, within a
            // second or so. Offering Approve and Deny here put the operator in a
            // race with that: buttons that usually lose, on a prompt that
            // vanishes by itself — which reads as the bypass not working.
            //
            // The request is still shown rather than hidden. If auto-resolution
            // ever fails, a silently absent prompt would strand the run with no
            // sign of why; this way the wait stays visible, and the banner above
            // offers the way back to manual approval.
            <p className="muted">Answered automatically by this run&rsquo;s approval policy.</p>
          ) : canManage ? (
            <div className="button-row">
              {choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="button"
                  disabled={pending}
                  onClick={() => onAction('approval', { choice })}
                >
                  {choice === 'deny' ? 'Deny' : `Approve (${choice})`}
                </button>
              ))}
              {policyState.policy === 'manual' && policySupported ? (
                <button
                  type="button"
                  className="button danger"
                  disabled={pending}
                  onClick={() => {
                    // Confirmed before it is sent: this both answers the waiting
                    // approval and stops the run asking again.
                    if (window.confirm(BYPASS_CONFIRMATION)) {
                      onAction('approval-policy', { policy: 'allow_all_for_run' });
                    }
                  }}
                >
                  {policyLabel('allow_all_for_run')}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="muted">You do not have permission to answer approvals.</p>
          )}
        </div>
      ) : null}

      {isActive(run) && canManage ? (
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => onAction('cancel')}
          >
            {pending ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      ) : null}

      {['interrupted', 'lost'].includes(run.status) && canManage ? (
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => onAction('retry')}
          >
            Retry this turn
          </button>
        </div>
      ) : null}

      {tools.length > 0 ? (
        <p className="chat-tools">
          {tools.map(describeToolUse).join(' · ')}
          {running ? <span className="chat-tools-running">{` · ${running.tool}…`}</span> : null}
        </p>
      ) : null}

      <details className="chat-technical">
        <summary>Technical details</summary>
        <TechnicalTimeline events={events} deltaCount={deltaCount} />
      </details>
    </div>
  );
}

/**
 * What the agent was thinking, with the raw journal kept one level deeper.
 *
 * A list of event names answered a question nobody was asking: an operator
 * opening this wants to know why the agent did what it did, and `Tool.Started`
 * repeated three times does not say. The reasoning the runtime already records
 * does, so that is what this shows first.
 *
 * The journal is not dropped, only demoted — gap detection and exact ordering
 * still have to be checkable, and nothing else records them.
 */
function TechnicalTimeline({ events, deltaCount }: { events: RunEvent[]; deltaCount: number }) {
  const reasoning = reasoningEntries(events);
  const rows: { key: string; label: string; seq: string; collapsed?: RunEvent[] }[] = [];
  let run: RunEvent[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    rows.push({
      key: `delta-${first.seq}`,
      label: `Assistant message — ${run.length} events`,
      seq: `#${first.seq}–${last.seq}`,
      collapsed: run,
    });
    run = [];
  };

  for (const event of events) {
    if (event.event_type === 'message.delta') {
      run.push(event);
      continue;
    }
    flush();
    rows.push({ key: String(event.seq), label: event.event_type, seq: `#${event.seq}` });
  }
  flush();

  return (
    <>
      {reasoning.length > 0 ? (
        <div className="chat-reasoning">
          {reasoning.map((entry) => (
            <article key={entry.seq}>
              <span className="mono-small">#{entry.seq}</span>
              <p>{entry.text}</p>
            </article>
          ))}
        </div>
      ) : (
        <p className="muted">The agent recorded no reasoning for this turn.</p>
      )}

      <details className="chat-journal">
        <summary>
          {`Journal — ${events.length} events, ${deltaCount} of them assistant message fragments`}
        </summary>
        <ol className="sequence">
          {rows.map((row) => (
            <li key={row.key}>
              <span className="mono-small">{row.seq}</span>
              {row.collapsed ? (
                <details>
                  <summary>{row.label}</summary>
                  <ol className="sequence">
                    {row.collapsed.map((event) => (
                      <li key={String(event.seq)}>
                        <span className="mono-small">#{event.seq}</span>
                        <span className="badge">{event.event_type}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              ) : (
                <span className="badge">{row.label}</span>
              )}
            </li>
          ))}
        </ol>
      </details>
    </>
  );
}

/** An attempt still producing events: streamed live. */
function LiveAttempt(props: {
  organizationId: string;
  run: ChatRun;
  canManage: boolean;
  onAction: (path: string, body?: unknown) => void;
  pending: boolean;
  actionError: unknown;
  policySupported: boolean;
  onTerminal: () => void;
}) {
  const live = useRunEvents(props.organizationId, props.run.run_id);
  const notified = useRef(false);
  useEffect(() => {
    if (live.state === 'complete' && !notified.current) {
      notified.current = true;
      props.onTerminal();
    }
  }, [live.state, props]);
  return (
    <AttemptBody
      run={props.run}
      events={live.events}
      streamState={live.state}
      canManage={props.canManage}
      onAction={props.onAction}
      pending={props.pending}
      actionError={props.actionError}
      policySupported={props.policySupported}
    />
  );
}

/** A finished attempt: its journal is fetched once, not streamed. */
function ArchivedAttempt(props: {
  organizationId: string;
  run: ChatRun;
  canManage: boolean;
  onAction: (path: string, body?: unknown) => void;
  pending: boolean;
  actionError: unknown;
  policySupported: boolean;
}) {
  const query = useQuery({
    queryKey: scopedKey(props.organizationId, 'run-events', props.run.run_id),
    queryFn: () =>
      apiRequest<{ events: RunEvent[] }>(
        `/api/v1/runs/${encodeURIComponent(props.run.run_id)}/events`,
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (query.isPending) return <Loading label="Loading reply" />;
  if (query.error) return <ErrorNotice error={query.error} />;
  return (
    <AttemptBody
      run={props.run}
      events={query.data.events}
      canManage={props.canManage}
      onAction={props.onAction}
      pending={props.pending}
      actionError={props.actionError}
      policySupported={props.policySupported}
    />
  );
}

// ------------------------------------------------------------------ chat

export function ProjectChat({
  projectId,
  organizationId,
  permissions,
  userId,
  projectAvailable,
}: {
  projectId: string;
  organizationId: string;
  permissions: string[];
  userId: string;
  projectAvailable: boolean;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState('');
  // Armed for the *next* message, and only through the confirmation dialog.
  const [bypassArmed, setBypassArmed] = useState(false);
  const [confirmingBypass, setConfirmingBypass] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  // Chosen files live here, in this browser, until the message is sent.
  const [localImages, setLocalImages] = useState<LocalImage[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Object URLs outlive the component unless revoked, so unmounting the chat —
  // navigating away with files still chosen — has to clean up too.
  useEffect(
    () => () => {
      localImages.forEach((image) => URL.revokeObjectURL(image.objectUrl));
    },
    // Intentionally on unmount only: revoking on every change would break the
    // previews still on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // A session minted for the very first message of a project. Once that run
  // exists the server owns the identity; this only bridges the gap before it.
  const [pendingSession, setPendingSession] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const chatKey = scopedKey(organizationId, 'project-chat', projectId);
  const chat = useQuery({
    queryKey: chatKey,
    queryFn: () =>
      apiRequest<ChatResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}/chat`),
    refetchInterval: (query) => {
      const runs = query.state.data?.runs ?? [];
      return runs.some((run) => isActive(run)) ? 2_000 : false;
    },
  });

  const refresh = () => void client.invalidateQueries({ queryKey: chatKey });

  const send = useMutation({
    mutationFn: (text: string) => {
      const sessionId = chat.data?.session_id ?? pendingSession ?? crypto.randomUUID();
      setPendingSession(sessionId);
      const path = `/api/v1/projects/${encodeURIComponent(projectId)}/runs`;
      const request = {
        input: text,
        session_id: sessionId,
        idempotency_key: crypto.randomUUID(),
        // Sent only when armed, so an ordinary message is byte-identical to
        // what it was before this feature existed.
        ...(bypassArmed ? { approval_policy: 'allow_all_for_run' } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };

      // Files turn the submission into multipart. Without them the request is
      // exactly the JSON one that has always been sent, so nothing changes for
      // a text-only message or a linked image URL.
      if (localImages.length === 0) {
        return apiRequest<{ run: ChatRun }>(path, { method: 'POST', ...jsonBody(request) });
      }

      const form = new FormData();
      form.append('request', JSON.stringify(request));
      localImages.forEach((image, index) => {
        form.append('images', image.file, image.file.name);
        if (image.alt.trim()) form.append(`alt.${index}`, image.alt.trim());
      });
      return apiRequest<{ run: ChatRun }>(path, { method: 'POST', body: form });
    },
    onSuccess: () => {
      // Armed for one message only: the next turn starts manual again.
      setBypassArmed(false);
      // The submitted turn now owns them; the composer starts empty. The object
      // URLs are revoked here rather than left to garbage collection, which
      // never reclaims them.
      setAttachments([]);
      setLocalImages((current) => {
        current.forEach((image) => URL.revokeObjectURL(image.objectUrl));
        return [];
      });
      setAttachmentError(null);
      // The draft is cleared only once the server accepted it, so a failed
      // submission never loses what the user typed.
      setDraft('');
      refresh();
    },
  });

  const action = useMutation({
    mutationFn: ({ runId, path, body }: { runId: string; path: string; body?: unknown }) =>
      apiRequest(`/api/v1/runs/${encodeURIComponent(runId)}/${path}`, {
        method: 'POST',
        ...(body ? jsonBody(body) : {}),
      }),
    onSuccess: refresh,
  });

  const turns = useMemo(() => groupTurns(chat.data?.runs ?? []), [chat.data?.runs]);
  const activeRun = (chat.data?.runs ?? []).find((run) => isActive(run));

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns.length, activeRun?.status]);

  if (chat.isPending) return <Loading label="Loading conversation" />;
  if (chat.error) return <ErrorNotice error={chat.error} />;

  const canSend = permissions.includes('run.create');
  // Read from the project response, never assumed: the owning Node's
  // authenticated advertisement is the only thing that may light this up, and
  // an offline Node withdraws availability even though support is still known.
  const policySupported = canOfferRunPolicy(chat.data?.node_capabilities);
  // Same rule as the approval control: offered only when the owning Node
  // advertises the type and is reachable.
  const attachmentsSupported = Boolean(chat.data?.node_capabilities?.image_attachments_available);
  const uploadLimits = chat.data?.uploads;
  // Three independent conditions, all required: storage configured here, a Node
  // that is online, and one that says it understands image attachments.
  const uploadsAvailable = Boolean(uploadLimits?.available);
  const totalAttached = attachments.length + localImages.length;

  /** Accept files from the picker, a drop, or a paste, by the same rules. */
  const addLocalImages = (incoming: File[]) => {
    if (!uploadLimits) return;
    const images = incoming.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) return;

    let room = uploadLimits.max_attachments - (attachments.length + localImages.length);
    const accepted: LocalImage[] = [];
    const problems: string[] = [];
    for (const file of images) {
      if (room <= 0) {
        problems.push(
          `At most ${uploadLimits.max_attachments} images can be attached to one message.`,
        );
        break;
      }
      const problem = localImageProblem(file, uploadLimits);
      if (problem) {
        problems.push(problem);
        continue;
      }
      accepted.push({
        id: crypto.randomUUID(),
        file,
        objectUrl: URL.createObjectURL(file),
        alt: '',
      });
      room -= 1;
    }
    if (accepted.length > 0) setLocalImages((current) => [...current, ...accepted]);
    setAttachmentError(problems.length > 0 ? problems.join(' ') : null);
  };

  const removeLocalImage = (id: string) => {
    setLocalImages((current) => {
      const target = current.find((image) => image.id === id);
      if (target) URL.revokeObjectURL(target.objectUrl);
      return current.filter((image) => image.id !== id);
    });
    setAttachmentError(null);
  };
  const canManageAny = permissions.includes('run.manage_any');
  const blocked = Boolean(activeRun) || !projectAvailable;
  const composerDisabled = !canSend || blocked || send.isPending;

  const submit = () => {
    const text = draft.trim();
    if (!text || composerDisabled) return;
    send.mutate(text);
  };

  return (
    <section className="panel chat">
      <h2>Conversation</h2>

      <div className="chat-log" ref={listRef}>
        {turns.length === 0 ? (
          <Empty>No messages yet. Describe what you want done in this project.</Empty>
        ) : (
          turns.map((turn) => (
            <article className="chat-turn" key={turn.primary.run_id}>
              <div className="chat-message user">
                {turn.primary.submitted_input ?? <span className="muted">Message unavailable</span>}
                <SubmittedAttachments run={turn.primary} />
              </div>
              {turn.attempts.map((attempt, index) => (
                <div key={attempt.run_id}>
                  {index > 0 ? (
                    <p className="muted chat-attempt-label">{`Attempt ${index + 1} — retry`}</p>
                  ) : null}
                  {isTerminal(attempt) ? (
                    <ArchivedAttempt
                      organizationId={organizationId}
                      run={attempt}
                      canManage={canManageAny || attempt.created_by_user_id === userId}
                      pending={action.isPending}
                      actionError={action.variables?.runId === attempt.run_id ? action.error : null}
                      onAction={(path, body) =>
                        action.mutate({ runId: attempt.run_id, path, body })
                      }
                      policySupported={policySupported}
                    />
                  ) : (
                    <LiveAttempt
                      organizationId={organizationId}
                      run={attempt}
                      canManage={canManageAny || attempt.created_by_user_id === userId}
                      pending={action.isPending}
                      actionError={action.variables?.runId === attempt.run_id ? action.error : null}
                      onAction={(path, body) =>
                        action.mutate({ runId: attempt.run_id, path, body })
                      }
                      policySupported={policySupported}
                      onTerminal={refresh}
                    />
                  )}
                </div>
              ))}
            </article>
          ))
        )}
      </div>

      {send.error ? <ErrorNotice error={send.error} /> : null}

      <form
        className={dragging ? 'chat-composer chat-composer-dragging' : 'chat-composer'}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onDragOver={(event) => {
          if (!uploadsAvailable || composerDisabled) return;
          // Only take over the drop when it actually carries files; a text drag
          // should still land in the textarea.
          if (!Array.from(event.dataTransfer.types).includes('Files')) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          if (!uploadsAvailable || composerDisabled) return;
          if (!Array.from(event.dataTransfer.types).includes('Files')) return;
          event.preventDefault();
          setDragging(false);
          addLocalImages(Array.from(event.dataTransfer.files));
        }}
      >
        <textarea
          aria-label="Message"
          placeholder={canSend ? 'Describe the task, or ask a question first…' : 'Read-only access'}
          rows={3}
          value={draft}
          disabled={composerDisabled}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            if (!uploadsAvailable || composerDisabled) return;
            const pasted = Array.from(event.clipboardData.files);
            if (pasted.length === 0) return;
            // A screenshot on the clipboard arrives as a file with no name.
            event.preventDefault();
            addLocalImages(pasted);
          }}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter inserts a line break.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {totalAttached > 0 ? (
          <ul className="chat-attachment-previews" aria-label="Attached images">
            {attachments.map((attachment, index) => (
              <li key={`${attachment.url}-${index}`} className="chat-attachment-card">
                <AttachmentThumbnail attachment={attachment} />
                <span className="chat-attachment-label">{attachmentLabel(attachment)}</span>
                <button
                  type="button"
                  className="button"
                  aria-label={`Remove ${attachmentLabel(attachment)}`}
                  onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </li>
            ))}
            {localImages.map((image) => (
              <li key={image.id} className="chat-attachment-card">
                {/* Rendered from browser memory: nothing has been uploaded yet. */}
                <img className="chat-attachment-thumb" src={image.objectUrl} alt="" />
                <span className="chat-attachment-label">
                  {image.file.name} · {describeBytes(image.file.size)}
                </span>
                <input
                  className="chat-attachment-alt"
                  type="text"
                  aria-label={`Label for ${image.file.name}`}
                  placeholder="Label (optional)"
                  value={image.alt}
                  maxLength={200}
                  disabled={composerDisabled}
                  onChange={(event) =>
                    setLocalImages((current) =>
                      current.map((item) =>
                        item.id === image.id ? { ...item, alt: event.target.value } : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="button"
                  aria-label={`Remove ${image.file.name}`}
                  onClick={() => removeLocalImage(image.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {attachmentError ? (
          <p className="chat-attachment-error" role="alert">
            {attachmentError}
          </p>
        ) : null}

        <div className="chat-composer-actions">
          {/* Kept out of the tab order and driven by the button beside it, so
              the control the user reaches is a real button with a real label. */}
          <input
            ref={fileInputRef}
            type="file"
            accept={(uploadLimits?.media_types ?? []).join(',')}
            multiple
            hidden
            tabIndex={-1}
            onChange={(event) => {
              addLocalImages(Array.from(event.target.files ?? []));
              // Reset so choosing the same file twice still fires a change.
              event.target.value = '';
              fileInputRef.current?.blur();
            }}
          />
          {uploadsAvailable ? (
            <button
              type="button"
              className="button"
              disabled={
                composerDisabled ||
                totalAttached >= (uploadLimits?.max_attachments ?? MAX_ATTACHMENTS)
              }
              onClick={() => fileInputRef.current?.click()}
            >
              Add image
            </button>
          ) : null}
          <button
            type="button"
            className="button"
            disabled={composerDisabled || !attachmentsSupported || totalAttached >= MAX_ATTACHMENTS}
            onClick={() => setAttaching(true)}
          >
            Attach image URL
          </button>
          <label className="chat-bypass-toggle">
            <input
              type="checkbox"
              checked={bypassArmed}
              disabled={composerDisabled}
              onChange={(event) => {
                // Arming is a deliberate act: the checkbox opens a dialog rather
                // than enabling anything, so a stray Enter in the composer can
                // never turn it on.
                if (event.target.checked) setConfirmingBypass(true);
                else setBypassArmed(false);
              }}
            />
            <span>{policyLabel('allow_all_for_run')}</span>
          </label>
          <span className="muted">
            {!canSend
              ? 'You do not have permission to send messages.'
              : !projectAvailable
                ? 'The project is unavailable.'
                : activeRun
                  ? 'Waiting for the current turn to finish.'
                  : 'Enter sends · Shift+Enter for a new line'}
          </span>
          <button type="submit" className="button" disabled={composerDisabled || !draft.trim()}>
            {send.isPending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>

      {attaching ? (
        <AttachImageDialog
          existing={attachments.length}
          onCancel={() => setAttaching(false)}
          onAttach={(attachment: Attachment) => {
            setAttachments((current) => [...current, attachment]);
            setAttaching(false);
          }}
        />
      ) : null}

      {confirmingBypass ? (
        <BypassConfirmation
          onCancel={() => {
            setConfirmingBypass(false);
            setBypassArmed(false);
          }}
          onConfirm={() => {
            setConfirmingBypass(false);
            setBypassArmed(true);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Images a submitted turn carried.
 *
 * Read from the run's stored metadata rather than component state, so a reload
 * rebuilds exactly these cards and a replayed event cannot add a second copy.
 */
function SubmittedAttachments({ run }: { run: ChatRun }) {
  const attachments = attachmentsOf(run);
  const uploaded = uploadedAttachmentsOf(run);
  if (attachments.length === 0 && uploaded.length === 0) return null;
  return (
    <ul className="chat-attachment-previews submitted" aria-label="Attached images">
      {uploaded.map((attachment) => (
        <UploadedAttachmentCard key={attachment.attachment_id} attachment={attachment} />
      ))}
      {attachments.map((attachment, index) => (
        <li key={`${attachment.url}-${index}`} className="chat-attachment-card">
          <AttachmentThumbnail attachment={attachment} />
          <a
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            className="chat-attachment-label"
          >
            {attachmentLabel(attachment)}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * A remote preview.
 *
 * Nothing here proves the model will see the image — the provider fetches it
 * separately at run time — so a failed load degrades to a labelled card and
 * never blocks sending. `no-referrer` keeps the console's URL out of the
 * request the browser makes to a third-party host.
 */
function UploadedAttachmentCard({ attachment }: { attachment: UploadedAttachment }) {
  const [failed, setFailed] = useState(false);
  const label =
    attachment.alt ||
    attachment.original_filename ||
    `${attachment.width}×${attachment.height} image`;
  return (
    <li className="chat-attachment-card">
      {failed || attachment.state !== 'ready' ? (
        <span className="chat-attachment-thumb chat-attachment-thumb-missing" aria-hidden="true" />
      ) : (
        <img
          className="chat-attachment-thumb"
          src={attachment.content_url}
          alt={attachment.alt ?? ''}
          onError={() => setFailed(true)}
        />
      )}
      <span className="chat-attachment-label">
        {label} · {describeBytes(attachment.byte_size)}
      </span>
    </li>
  );
}

function AttachmentThumbnail({ attachment }: { attachment: Attachment }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className="chat-attachment-thumb broken" aria-hidden="true">
        🖼
      </span>
    );
  }
  return (
    <img
      className="chat-attachment-thumb"
      src={attachment.url}
      alt={attachment.alt ?? ''}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

/** Collect one image URL and an optional label. */
function AttachImageDialog({
  existing,
  onCancel,
  onAttach,
}: {
  existing: number;
  onCancel: () => void;
  onAttach: (attachment: Attachment) => void;
}) {
  const [url, setUrl] = useState('');
  const [alt, setAlt] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    urlRef.current?.focus();
    return () => {
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  const attach = () => {
    const found = attachmentProblem(url, existing);
    if (found) {
      setProblem(found);
      return;
    }
    onAttach(makeAttachment(url, alt));
  };

  return (
    <div
      className="chat-bypass-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="attach-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <div className="chat-bypass-dialog-inner">
        <h4 id="attach-title">Attach image URL</h4>
        <p className="muted">
          The image is fetched by the model provider, not by Asterism. Only attach a URL you are
          willing to share with it.
        </p>
        <label className="chat-attach-field">
          <span>Image URL</span>
          <input
            ref={urlRef}
            type="url"
            value={url}
            placeholder="https://example.com/diagram.png"
            onChange={(event) => {
              setUrl(event.target.value);
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                attach();
              }
            }}
          />
        </label>
        <label className="chat-attach-field">
          <span>Label (optional)</span>
          <input
            type="text"
            value={alt}
            placeholder="What this shows"
            onChange={(event) => setAlt(event.target.value)}
          />
        </label>
        {problem ? (
          <p className="notice" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="button-row">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button" onClick={attach}>
            Attach
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Explicit confirmation before arming the run-scoped bypass.
 *
 * A dialog rather than an inline toggle because the operator is agreeing to
 * something with consequences on their machine, and because a checkbox next to
 * a textarea is one stray keystroke away from being set by accident.
 */
function BypassConfirmation({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    confirmRef.current?.focus();
    return () => {
      // Focus goes back where it was, so keyboard users are not dropped at the
      // top of the document when the dialog closes.
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  return (
    <div
      className="chat-bypass-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="bypass-title"
      aria-describedby="bypass-body"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <div className="chat-bypass-dialog-inner">
        <h4 id="bypass-title">{policyLabel('allow_all_for_run')}</h4>
        <p id="bypass-body">{BYPASS_CONFIRMATION}</p>
        <div className="button-row">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button ref={confirmRef} type="button" className="button danger" onClick={onConfirm}>
            Enable for this run
          </button>
        </div>
      </div>
    </div>
  );
}
