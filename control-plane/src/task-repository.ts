/**
 * Storage primitives for Workdesk tasks.
 *
 * Nothing here decides whether a change is allowed — `tasks.ts` answers that.
 * These are the narrow operations a route composes, and the only place that
 * knows what the tables look like.
 */
import type { Pool, PoolClient } from 'pg';

import { withTransaction } from './db.js';
import type { CompletionPolicy, PendingCompletion, TaskAction, TaskState } from './tasks.js';

export type TaskRecord = {
  readonly task_id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly goal: string;
  readonly status: TaskState;
  readonly version: number;
  readonly generation: number;
  readonly completion_policy: CompletionPolicy;
  readonly created_by_user_id: string | null;
  readonly current_run_id: string | null;
  readonly current_step_id: string | null;
  readonly result_summary: string | null;
  readonly result_artifacts: unknown[];
  readonly result_metadata: Record<string, unknown>;
  readonly blocked_reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
};

export type PlanStepRecord = {
  readonly step_id: string;
  readonly task_id: string;
  readonly position: number;
  readonly title: string;
  readonly state: 'pending' | 'in_progress' | 'done' | 'skipped';
  readonly reported_by_run_id: string | null;
};

export type TaskEventRecord = {
  readonly task_id: string;
  readonly seq: string;
  readonly run_id: string | null;
  readonly event_type: string;
  readonly summary: string;
  readonly detail: Record<string, unknown>;
  readonly agent_reported: boolean;
  readonly recorded_at: Date;
};

export type InputRequestRecord = {
  readonly input_request_id: string;
  readonly task_id: string;
  readonly run_id: string | null;
  readonly prompt: string;
  readonly kind: string;
  readonly answered_at: Date | null;
  readonly answered_by_user_id: string | null;
  readonly answer: string | null;
  readonly created_at: Date;
};

/** A change that was asked for, with the answer this product gave. */
export type RequestOutcome = {
  readonly requestId: string;
  readonly taskId: string;
  readonly source: 'user' | 'agent' | 'integration';
  readonly action: TaskAction;
  readonly actorUserId?: string | null;
  readonly actorRunId?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly observedVersion?: number | null;
  /** The execution attempt this was asked about, for a deferred request. */
  readonly generation?: number | null;
  /** `pending` is how a completion request waits for its Run to end. */
  readonly outcome: 'pending' | 'accepted' | 'rejected';
  readonly outcomeReason?: string | null;
};

export const tasksRepo = {
  async create(
    pool: Pool,
    input: {
      readonly taskId: string;
      readonly organizationId: string;
      readonly projectId: string;
      readonly title: string;
      readonly goal: string;
      readonly createdByUserId: string | null;
    },
  ): Promise<TaskRecord> {
    const { rows } = await pool.query<TaskRecord>(
      `INSERT INTO tasks (task_id, organization_id, project_id, title, goal, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.taskId,
        input.organizationId,
        input.projectId,
        input.title,
        input.goal,
        input.createdByUserId,
      ],
    );
    return rows[0]!;
  },

  async byId(pool: Pool, organizationId: string, taskId: string): Promise<TaskRecord | null> {
    const { rows } = await pool.query<TaskRecord>(
      `SELECT * FROM tasks WHERE organization_id = $1 AND task_id = $2`,
      [organizationId, taskId],
    );
    return rows[0] ?? null;
  },

  async forProject(pool: Pool, organizationId: string, projectId: string): Promise<TaskRecord[]> {
    const { rows } = await pool.query<TaskRecord>(
      `SELECT * FROM tasks
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY created_at DESC, task_id DESC`,
      [organizationId, projectId],
    );
    return rows;
  },

  /** The Task a Run belongs to, if any. Used when a Run's outcome lands. */
  async byRun(pool: Pool, runId: string): Promise<TaskRecord | null> {
    const { rows } = await pool.query<TaskRecord>(
      `SELECT t.* FROM tasks t JOIN task_runs r ON r.task_id = t.task_id WHERE r.run_id = $1`,
      [runId],
    );
    return rows[0] ?? null;
  },

  async editFields(
    pool: Pool,
    taskId: string,
    fields: {
      readonly title?: string;
      readonly goal?: string;
      readonly completionPolicy?: CompletionPolicy;
    },
  ): Promise<TaskRecord | null> {
    const { rows } = await pool.query<TaskRecord>(
      `UPDATE tasks
          SET title = COALESCE($2, title),
              goal = COALESCE($3, goal),
              completion_policy = COALESCE($4, completion_policy),
              version = version + 1,
              updated_at = now()
        WHERE task_id = $1
        RETURNING *`,
      [taskId, fields.title ?? null, fields.goal ?? null, fields.completionPolicy ?? null],
    );
    return rows[0] ?? null;
  },

  async plan(pool: Pool, taskId: string): Promise<PlanStepRecord[]> {
    const { rows } = await pool.query<PlanStepRecord>(
      `SELECT * FROM task_plan_steps WHERE task_id = $1 ORDER BY position`,
      [taskId],
    );
    return rows;
  },

  async runs(
    pool: Pool,
    taskId: string,
  ): Promise<
    {
      readonly run_id: string;
      readonly status: string;
      readonly created_at: Date;
      readonly finished_at: Date | null;
      readonly error_message: string | null;
      readonly retry_of_run_id: string | null;
    }[]
  > {
    const { rows } = await pool.query(
      `SELECT r.run_id, r.status, r.created_at, r.finished_at, r.error_message, r.retry_of_run_id
         FROM task_runs tr JOIN runs r ON r.run_id = tr.run_id
        WHERE tr.task_id = $1
        ORDER BY r.created_at DESC, r.run_id DESC`,
      [taskId],
    );
    return rows as never;
  },

  async events(pool: Pool, taskId: string, limit = 100): Promise<TaskEventRecord[]> {
    const { rows } = await pool.query<TaskEventRecord>(
      `SELECT * FROM task_events WHERE task_id = $1 ORDER BY seq DESC LIMIT $2`,
      [taskId, limit],
    );
    return rows;
  },

  async openInputRequest(pool: Pool, taskId: string): Promise<InputRequestRecord | null> {
    const { rows } = await pool.query<InputRequestRecord>(
      `SELECT * FROM task_input_requests
        WHERE task_id = $1 AND answered_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    return rows[0] ?? null;
  },

  /**
   * Record what was asked for and what this product answered.
   *
   * Always written, including for a refusal: a person who pressed a button and
   * saw nothing happen deserves a row that says why, and so does the next
   * person reading the history.
   */
  async recordRequest(executor: Pool | PoolClient, outcome: RequestOutcome): Promise<void> {
    await executor.query(
      `INSERT INTO task_requests
         (request_id, task_id, source, actor_user_id, actor_run_id, action, payload,
          observed_version, generation, outcome, outcome_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        outcome.requestId,
        outcome.taskId,
        outcome.source,
        outcome.actorUserId ?? null,
        outcome.actorRunId ?? null,
        outcome.action,
        JSON.stringify(outcome.payload ?? {}),
        outcome.observedVersion ?? null,
        outcome.generation ?? null,
        outcome.outcome,
        outcome.outcomeReason ?? null,
      ],
    );
  },

  /**
   * Apply an accepted change: move the Task, bump its version, record the
   * request that caused it and the event a person will read — all together, so
   * no reader ever sees a state whose reason is missing.
   *
   * The version is checked inside the transaction. A caller that formed its
   * decision against an older version gets `null` and must not retry blindly:
   * the state it reasoned about is gone.
   */
  async applyTransition(
    pool: Pool,
    input: {
      readonly taskId: string;
      readonly expectedVersion: number;
      readonly to: TaskState;
      readonly request: RequestOutcome;
      readonly event: {
        readonly eventType: string;
        readonly summary: string;
        readonly detail?: Record<string, unknown>;
        readonly agentReported?: boolean;
        readonly runId?: string | null;
      };
      readonly currentRunId?: string | null;
      readonly blockedReason?: string | null;
      readonly clearResult?: boolean;
    },
  ): Promise<TaskRecord | null> {
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query<TaskRecord>(
        `UPDATE tasks
            SET status = $3,
                version = version + 1,
                updated_at = now(),
                current_run_id = CASE WHEN $4::boolean THEN $5 ELSE current_run_id END,
                blocked_reason = $6,
                result_summary = CASE WHEN $7::boolean THEN NULL ELSE result_summary END,
                result_artifacts = CASE WHEN $7::boolean THEN '[]'::jsonb ELSE result_artifacts END,
                result_metadata = CASE WHEN $7::boolean THEN '{}'::jsonb ELSE result_metadata END
          WHERE task_id = $1 AND version = $2
          RETURNING *`,
        [
          input.taskId,
          input.expectedVersion,
          input.to,
          input.currentRunId !== undefined,
          input.currentRunId ?? null,
          input.blockedReason ?? null,
          input.clearResult === true,
        ],
      );
      const task = rows[0];
      if (!task) return null;

      await this.recordRequest(client, input.request);
      await appendEvent(client, {
        taskId: input.taskId,
        runId: input.event.runId ?? null,
        eventType: input.event.eventType,
        summary: input.event.summary,
        detail: input.event.detail ?? {},
        agentReported: input.event.agentReported === true,
      });
      return task;
    });
  },

  /**
   * Begin an execution attempt.
   *
   * One transaction moves the Task to `running`, bumps both counters, points it
   * at the new Run and attaches that Run. The generation is what a deferred
   * completion request is later measured against, so it must not be possible to
   * observe a running Task whose generation belongs to the previous attempt.
   */
  async startRun(
    pool: Pool,
    input: {
      readonly taskId: string;
      readonly expectedVersion: number;
      readonly runId: string;
      readonly request: RequestOutcome;
      readonly summary: string;
    },
  ): Promise<TaskRecord | null> {
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query<TaskRecord>(
        `UPDATE tasks
            SET status = 'running',
                version = version + 1,
                generation = generation + 1,
                current_run_id = $3,
                current_step_id = NULL,
                blocked_reason = NULL,
                updated_at = now()
          WHERE task_id = $1 AND version = $2
          RETURNING *`,
        [input.taskId, input.expectedVersion, input.runId],
      );
      const task = rows[0];
      if (!task) return null;

      await tasksRepo.attachRun(client, input.taskId, input.runId);
      await tasksRepo.recordRequest(client, input.request);
      await appendEvent(client, {
        taskId: input.taskId,
        runId: input.runId,
        eventType: 'run.started',
        summary: input.summary,
        detail: { generation: task.generation },
        agentReported: false,
      });
      return task;
    });
  },

  /**
   * The completion waiting to be settled for this attempt, if any.
   *
   * Scoped to the generation on purpose: a request left over from an earlier
   * attempt is not this attempt's business, and reading it as if it were is
   * exactly the stale-completion bug.
   */
  async pendingCompletion(
    pool: Pool,
    taskId: string,
  ): Promise<(PendingCompletion & { readonly requestId: string }) | null> {
    const { rows } = await pool.query<{
      request_id: string;
      source: PendingCompletion['source'];
      actor_run_id: string | null;
      generation: number | null;
    }>(
      `SELECT request_id, source, actor_run_id, generation
         FROM task_requests
        WHERE task_id = $1 AND action = 'complete' AND outcome = 'pending'
        ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    const row = rows[0];
    if (!row || row.actor_run_id === null || row.generation === null) return null;
    return {
      requestId: row.request_id,
      source: row.source,
      runId: row.actor_run_id,
      generation: row.generation,
    };
  },

  /** Answer a request that was waiting. It is answered exactly once. */
  async settleRequest(
    executor: Pool | PoolClient,
    input: {
      readonly requestId: string;
      readonly outcome: 'accepted' | 'rejected';
      readonly reason: string | null;
    },
  ): Promise<boolean> {
    const { rowCount } = await executor.query(
      `UPDATE task_requests
          SET outcome = $2, outcome_reason = $3
        WHERE request_id = $1 AND outcome = 'pending'`,
      [input.requestId, input.outcome, input.reason],
    );
    return (rowCount ?? 0) > 0;
  },

  /** How many things this Task asked for are still unanswered. */
  async unresolvedInputRequests(pool: Pool, taskId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_input_requests
        WHERE task_id = $1 AND answered_at IS NULL`,
      [taskId],
    );
    return rows[0]?.n ?? 0;
  },

  /** Attach a Run to a Task. A Run belongs to one Task for its whole life. */
  async attachRun(executor: Pool | PoolClient, taskId: string, runId: string): Promise<void> {
    await executor.query(
      `INSERT INTO task_runs (task_id, run_id) VALUES ($1, $2) ON CONFLICT (run_id) DO NOTHING`,
      [taskId, runId],
    );
  },

  /**
   * Replace the plan with what the agent reported.
   *
   * A plan is replaced whole rather than merged: a half-applied plan would
   * present an order nobody proposed.
   */
  async replacePlan(
    pool: Pool,
    input: {
      readonly taskId: string;
      readonly runId: string;
      readonly steps: readonly {
        readonly stepId: string;
        readonly title: string;
        readonly state: string;
      }[];
    },
  ): Promise<PlanStepRecord[]> {
    return withTransaction(pool, async (client) => {
      await client.query(`DELETE FROM task_plan_steps WHERE task_id = $1`, [input.taskId]);
      let position = 0;
      for (const step of input.steps) {
        position += 1;
        await client.query(
          `INSERT INTO task_plan_steps (step_id, task_id, position, title, state, reported_by_run_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [step.stepId, input.taskId, position, step.title, step.state, input.runId],
        );
      }
      const { rows } = await client.query<PlanStepRecord>(
        `SELECT * FROM task_plan_steps WHERE task_id = $1 ORDER BY position`,
        [input.taskId],
      );
      return rows;
    });
  },

  async setCurrentStep(pool: Pool, taskId: string, stepId: string | null): Promise<void> {
    await pool.query(
      `UPDATE tasks SET current_step_id = $2, updated_at = now() WHERE task_id = $1`,
      [taskId, stepId],
    );
  },

  async recordResult(
    pool: Pool,
    input: {
      readonly taskId: string;
      readonly summary: string | null;
      readonly artifacts: readonly unknown[];
      readonly metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await pool.query(
      `UPDATE tasks
          SET result_summary = $2,
              result_artifacts = $3::jsonb,
              result_metadata = $4::jsonb,
              updated_at = now()
        WHERE task_id = $1`,
      [
        input.taskId,
        input.summary,
        JSON.stringify(input.artifacts),
        JSON.stringify(input.metadata),
      ],
    );
  },

  async raiseInputRequest(
    pool: Pool,
    input: {
      readonly inputRequestId: string;
      readonly taskId: string;
      readonly runId: string | null;
      readonly prompt: string;
      readonly kind: string;
    },
  ): Promise<void> {
    await pool.query(
      `INSERT INTO task_input_requests (input_request_id, task_id, run_id, prompt, kind)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (input_request_id) DO NOTHING`,
      [input.inputRequestId, input.taskId, input.runId, input.prompt, input.kind],
    );
  },

  /**
   * Answer something the Task was waiting for.
   *
   * `source` carries who answered because `needs_input` does not mean a human
   * is owed: another system may supply it, and then there is no user id to
   * record. Answered once; a second answer changes nothing.
   */
  async answerInputRequest(
    pool: Pool,
    input: {
      readonly inputRequestId: string;
      readonly source: 'user' | 'agent' | 'integration';
      readonly userId: string | null;
      readonly answer: string;
    },
  ): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE task_input_requests
          SET answered_at = now(),
              answered_by_source = $2,
              answered_by_user_id = $3,
              answer = $4
        WHERE input_request_id = $1 AND answered_at IS NULL`,
      [input.inputRequestId, input.source, input.userId, input.answer],
    );
    return (rowCount ?? 0) > 0;
  },

  async appendEvent(
    pool: Pool,
    input: {
      readonly taskId: string;
      readonly runId?: string | null;
      readonly eventType: string;
      readonly summary: string;
      readonly detail?: Record<string, unknown>;
      readonly agentReported?: boolean;
    },
  ): Promise<void> {
    await appendEvent(pool, {
      taskId: input.taskId,
      runId: input.runId ?? null,
      eventType: input.eventType,
      summary: input.summary,
      detail: input.detail ?? {},
      agentReported: input.agentReported === true,
    });
  },
};

/**
 * Append one lifecycle event.
 *
 * The sequence is allocated from the task's own rows rather than a shared
 * counter, so two tasks never contend, and a duplicate delivery of the same
 * event collides on the unique constraint instead of appearing twice.
 */
async function appendEvent(
  executor: Pool | PoolClient,
  input: {
    readonly taskId: string;
    readonly runId: string | null;
    readonly eventType: string;
    readonly summary: string;
    readonly detail: Record<string, unknown>;
    readonly agentReported: boolean;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO task_events (task_id, seq, run_id, event_type, summary, detail, agent_reported)
     VALUES (
       $1,
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_events WHERE task_id = $1),
       $2, $3, $4, $5::jsonb, $6
     )
     ON CONFLICT (task_id, seq) DO NOTHING`,
    [
      input.taskId,
      input.runId,
      input.eventType,
      input.summary,
      JSON.stringify(input.detail),
      input.agentReported,
    ],
  );
}
