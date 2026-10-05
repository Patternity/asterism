/**
 * The Workdesk: a project's tasks on a board, and one task in full.
 *
 * Chat stays the way a person talks to a project. This is where the work that
 * outlives a single turn is kept, so a task survives the run that attempted it
 * and a person can see what happened without reading an event stream.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';

import { apiRequest, jsonBody, scopedKey } from './api';
import { Empty, ErrorNotice, Loading, PageHeader, StatusBadge } from './components';
import {
  BOARD_ORDER,
  activityAttribution,
  groupByStatus,
  offeredActions,
  pendingCompletionNote,
  planAbsenceReason,
  type BoardTask,
  type StructuredReports,
  type TaskAction,
  type TaskDetail,
} from './workdesk-view';
import type { SessionResponse } from './types';

function useProductSession(): SessionResponse {
  return useOutletContext<SessionResponse>();
}

function organizationId(session: SessionResponse): string {
  if (!session.active_organization) throw new Error('active organization is required');
  return session.active_organization.organization_id;
}

/**
 * What a person is told when the owning Node cannot carry structured reports.
 *
 * Shown rather than hidden: the tasks still run, and a person who is not told
 * this waits for a plan that is never coming and wonders why nothing ever
 * completes by itself. The sentence comes from the server so the product says
 * one thing in one voice.
 */
function ReportsNotice({ reports }: { reports: StructuredReports }) {
  if (!reports.explanation) return null;
  return (
    <p className="notice" role="status">
      {reports.explanation}
    </p>
  );
}

/** One project's board. */
export function WorkdeskPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const { projectId = '' } = useParams();
  const canManage = session.permissions.includes('project.manage');

  const query = useQuery({
    queryKey: scopedKey(org, 'workdesk', projectId),
    queryFn: () =>
      apiRequest<{
        columns: { state: string; label: string }[];
        structured_reports: StructuredReports;
        tasks: BoardTask[];
      }>(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`),
    // A running task changes without anybody clicking, so the board asks again
    // rather than showing a state that has already moved on.
    refetchInterval: (q) =>
      (q.state.data?.tasks ?? []).some((task) => task.status === 'running') ? 4000 : false,
  });

  if (query.isPending) return <Loading label="Loading tasks" />;
  if (query.error) return <ErrorNotice error={query.error} />;

  const grouped = groupByStatus(query.data.tasks);
  const labels = new Map(query.data.columns.map((column) => [column.state, column.label]));

  return (
    <>
      <PageHeader
        title="Workdesk"
        description="Work that outlives a single run."
        actions={
          <Link className="button" to={`/projects/${encodeURIComponent(projectId)}`}>
            Back to project
          </Link>
        }
      />
      <ReportsNotice reports={query.data.structured_reports} />
      {canManage ? <NewTaskForm projectId={projectId} /> : null}
      {query.data.tasks.length === 0 ? (
        <Empty>No tasks yet. Describe one above and it will appear in Backlog.</Empty>
      ) : (
        <div className="board">
          {BOARD_ORDER.map((status) => {
            const tasks = grouped.get(status) ?? [];
            // An empty terminal column is noise; an empty active one is
            // information, so the ones work moves through always stay.
            if (tasks.length === 0 && ['completed', 'failed', 'cancelled'].includes(status)) {
              return null;
            }
            return (
              <section
                className="board-column"
                key={status}
                aria-label={labels.get(status) ?? status}
              >
                <h3>
                  {labels.get(status) ?? status} <span className="muted">{tasks.length}</span>
                </h3>
                {tasks.map((task) => (
                  <article className="board-card" key={task.task_id}>
                    <Link to={`/tasks/${encodeURIComponent(task.task_id)}`}>{task.title}</Link>
                    <StatusBadge status={task.status} />
                    {task.blocked_reason ? <p className="muted">{task.blocked_reason}</p> : null}
                  </article>
                ))}
                {tasks.length === 0 ? <p className="muted">Nothing here.</p> : null}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function NewTaskForm({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const create = useMutation({
    mutationFn: () =>
      apiRequest<{ task: TaskDetail }>(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, {
        method: 'POST',
        ...jsonBody({ title, goal }),
      }),
    onSuccess: () => {
      setTitle('');
      setGoal('');
      void client.invalidateQueries();
    },
  });

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() === '' || create.isPending) return;
        create.mutate();
      }}
    >
      <h2>New task</h2>
      <label>
        Title
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
      </label>
      <label>
        Goal
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={3}
          placeholder="What should be true when this is done?"
        />
      </label>
      {create.error ? <ErrorNotice error={create.error} /> : null}
      <button className="button" type="submit" disabled={create.isPending || title.trim() === ''}>
        {create.isPending ? 'Creating…' : 'Create task'}
      </button>
    </form>
  );
}

/** One task, in full. */
export function TaskDetailPage() {
  const session = useProductSession();
  const org = organizationId(session);
  const { taskId = '' } = useParams();
  const canManage = session.permissions.includes('project.manage');
  const client = useQueryClient();

  const query = useQuery({
    queryKey: scopedKey(org, 'task', taskId),
    queryFn: () => apiRequest<{ task: TaskDetail }>(`/api/v1/tasks/${encodeURIComponent(taskId)}`),
    refetchInterval: (q) => (q.state.data?.task.status === 'running' ? 4000 : false),
  });

  const act = useMutation({
    mutationFn: (action: TaskAction) =>
      apiRequest<{ task: TaskDetail }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/actions`, {
        method: 'POST',
        ...jsonBody({ action }),
      }),
    onSuccess: () => {
      void client.invalidateQueries();
    },
  });

  if (query.isPending) return <Loading label="Loading task" />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const task = query.data.task;
  const planNote = planAbsenceReason(task);
  const pendingNote = pendingCompletionNote(task);

  return (
    <>
      <PageHeader
        title={task.title}
        description={task.status_label}
        actions={
          <Link className="button" to={`/projects/${encodeURIComponent(task.project_id)}/workdesk`}>
            Back to Workdesk
          </Link>
        }
      />
      <ReportsNotice reports={task.structured_reports} />

      <section className="panel">
        <h2>Goal</h2>
        {task.goal.trim() === '' ? <Empty>No goal written.</Empty> : <p>{task.goal}</p>}
        <dl>
          <dt>State</dt>
          <dd>
            <StatusBadge status={task.status} />
          </dd>
          <dt>Completion</dt>
          <dd>
            {task.completion_policy === 'agent_outcome'
              ? 'An accepted outcome from the run can complete this task.'
              : 'Somebody has to complete this task after reviewing it.'}
          </dd>
        </dl>
        {pendingNote ? (
          <p className="notice" role="status">
            {pendingNote}
          </p>
        ) : null}
        {task.blocked_reason ? (
          <p className="notice" role="status">
            {task.blocked_reason}
          </p>
        ) : null}
        {canManage ? (
          <div className="button-row">
            {offeredActions(task.status).map((offer) => (
              <button
                className="button"
                key={offer.action}
                type="button"
                disabled={act.isPending}
                onClick={() => act.mutate(offer.action)}
              >
                {offer.label}
              </button>
            ))}
          </div>
        ) : null}
        {act.error ? <ErrorNotice error={act.error} /> : null}
      </section>

      {task.input_request ? (
        <InputRequestPanel taskId={taskId} request={task.input_request} canManage={canManage} />
      ) : null}

      <section className="panel">
        <h2>Plan</h2>
        {planNote ? <Empty>{planNote}</Empty> : null}
        {task.plan.length > 0 ? (
          <ol>
            {task.plan.map((step) => (
              <li key={step.step_id}>
                {step.title} <span className="muted">{step.state.replaceAll('_', ' ')}</span>
                {step.step_id === task.current_step_id ? (
                  <span className="badge">current</span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <section className="panel">
        <h2>Result</h2>
        {task.result.summary ? <p>{task.result.summary}</p> : <Empty>Nothing reported yet.</Empty>}
        {Array.isArray(task.result.artifacts) && task.result.artifacts.length > 0 ? (
          <>
            <h3>Artifacts the run reported</h3>
            <ul>
              {task.result.artifacts.map((artifact, index) => (
                <li key={index}>{String(artifact)}</li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="panel">
        <h2>Activity</h2>
        {task.events.length === 0 ? (
          <Empty>Nothing has happened yet.</Empty>
        ) : (
          <ul className="activity">
            {task.events.map((event) => (
              <li key={event.seq}>
                {event.summary}
                {activityAttribution(event) === 'agent' ? (
                  <span className="badge">agent reported</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Runs</h2>
        {task.runs.length === 0 ? (
          <Empty>This task has not been run yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Started</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {task.runs.map((run) => (
                <tr key={run.run_id}>
                  <td>
                    <Link className="mono-link" to={`/runs/${encodeURIComponent(run.run_id)}`}>
                      {run.run_id.slice(0, 11)}…
                    </Link>
                    {run.retry_of_run_id ? <span className="badge">retry</span> : null}
                  </td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td>{new Date(run.created_at).toLocaleString()}</td>
                  <td>{run.finished_at ? new Date(run.finished_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/**
 * Something the task is waiting for.
 *
 * Deliberately not the runtime's approval queue: approving a tool operation and
 * answering a question are different acts, and a panel that mixed them would
 * let one be mistaken for the other.
 */
function InputRequestPanel({
  taskId,
  request,
  canManage,
}: {
  taskId: string;
  request: NonNullable<TaskDetail['input_request']>;
  canManage: boolean;
}) {
  const client = useQueryClient();
  const [answer, setAnswer] = useState('');
  const reply = useMutation({
    mutationFn: () =>
      apiRequest<{ task: TaskDetail }>(
        `/api/v1/tasks/${encodeURIComponent(taskId)}/input-requests/${encodeURIComponent(
          request.input_request_id,
        )}`,
        { method: 'POST', ...jsonBody({ answer }) },
      ),
    onSuccess: () => {
      setAnswer('');
      void client.invalidateQueries();
    },
  });

  return (
    <section className="panel">
      <h2>Waiting for input</h2>
      <p>{request.prompt}</p>
      {canManage ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (answer.trim() === '' || reply.isPending) return;
            reply.mutate();
          }}
        >
          <label>
            Answer
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              rows={3}
              aria-label="Answer"
            />
          </label>
          {reply.error ? <ErrorNotice error={reply.error} /> : null}
          <button
            className="button"
            type="submit"
            disabled={reply.isPending || answer.trim() === ''}
          >
            {reply.isPending ? 'Sending…' : 'Send answer'}
          </button>
        </form>
      ) : null}
      <p className="muted">
        Answering makes the task workable again. It does not start it, and it approves no tool
        operation.
      </p>
    </section>
  );
}
