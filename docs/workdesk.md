# Workdesk: persistent project tasks

A Task is a unit of work a person wants done in a project. It outlives the Runs
that attempt it. This document records the design, and in particular how an
executing agent reports structured progress, because that is the part a reader
will otherwise assume was invented.

Status: implemented. Control Plane schema 20, Node registry schema 11. Not yet
deployed: the branch is `feat/workdesk-tasks`.

What is built, and what each part actually does:

| | |
|---|---|
| Task lifecycle | `control-plane/src/tasks.ts` — the one place a Task's fate is decided |
| Storage | migration `020_workdesk_tasks.sql`, `control-plane/src/task-repository.ts` |
| Routes | board, create, detail, edit, actions, answer — in `product-api.ts` |
| Console | `control-plane/web/src/workdesk.tsx`, `workdesk-view.ts` |
| Capability | advertised by the Node in `src/service.rs`, read in `node-capabilities.ts` |
| Bridge | `src/workdesk.rs` — minting, binding, reading, durable queueing |
| Ingestion | `handleTaskReport` and `settleTaskAfterRun` in `node-channel.ts` |

## The journey this serves

Create a task → read its plan → start execution → understand progress or what
is blocking it → inspect the result and the Runs that produced it.

Chat stays the primary way to talk to a project. A Task is not a second chat: a
Task's conversation is the project's existing conversation, filtered to the Runs
that belong to that Task.

## Who owns what

Asterism owns Task state. The runtime owns execution. These never merge.

- A **Task** lives in the Control Plane's PostgreSQL. It has an id, a project, a
  title and goal, a creator in the existing actor convention, a status, a
  version, ordered plan steps, an optional current step, a result summary with
  artifact references, and timestamps.
- A **Run** is unchanged. Runs remain immutable history with their existing
  retry lineage. A Task points at many Runs; a Run belongs to at most one Task.
- A **request** is a recorded wish — from a person, from the executing agent,
  later from an external board. It is not a state change. It records its source,
  the action asked for, and whether it was accepted or rejected and why. The
  source label is never authorization.

### Task states

```
backlog  ready  running  waiting_input  review  completed  failed  cancelled
```

Transitions are defined in one place and nowhere else.

### Three things that are not the same

Most of this design exists to keep these apart. Confusing any two of them is the
bug it is built to prevent.

| | What it is | Who produces it | What it decides |
|---|---|---|---|
| **Run completion** | an execution attempt durably ended successfully | the Node, recorded by the Control Plane | nothing about the Task on its own |
| **A completion request** | somebody asked for the Task to be finished — the agent calling `kanban_complete`, or a person pressing the button while work is running | agent through its Node, or an authorized person | nothing by itself; it is stored, pending, against the Task **and** the Run that was executing |
| **Accepted Task completion** | the Control Plane settled a pending request after its Run ended | the Control Plane | this, and only this, moves a Task to `completed` |

A successful Run with no completion request goes to `review`. A successful Run
with a request that is still valid goes to `completed` — no person required,
because that is the default path and an agent's explicit outcome is worth
something. "Still valid" means all of:

- it was asked about **this** execution generation and **this** Run,
- the Task's completion policy is `agent_outcome` rather than `explicit_review`,
- and nothing the Task asked for is still unanswered.

A request that fails any of those is **answered**, not left pending, and the
Task goes to `review` with the reason on it. A Run that failed or was cancelled
can never produce `completed`, whatever was requested while it ran; the Task
ends visibly failed with its reason and a retry path, and a retry stays attached
to the same Task.

`generation` is what makes "this attempt" answerable. `version` changes on every
edit; `generation` changes only when work is started again. A request carries
the generation it was made in, so a late tool call from a superseded attempt
cannot settle a later one even if a Run id were somehow reused.

### Waiting for input is not waiting for a human

`waiting_input` means **external input is required**. It may be owed by a
person, or by another system. The state's label, the stored answer and the
request's own record are all actor-neutral: who answered is recorded as a
source beside an optional user, and nothing in the model assumes a human. It
stays separate from the runtime's approval mechanism, because approving a tool
operation and answering a question are different acts with different
consequences.

## How the agent reports, concretely

This is the part that cannot be hand-waved. The requirement is a real
integration, not a prompt asking the model to please print JSON, and not prose
parsed as if it were state.

### What the pinned runtime already provides

Hermes 0.20.3 — the version `scripts/install.sh` pins and the version running on
the production Node — ships a **kanban toolset**: a set of registered tools a
worker agent calls to report structured progress. They are real tool calls with
JSON schemas, not text conventions:

| Tool | Arguments that matter | What it reports |
|---|---|---|
| `kanban_show` / `kanban_list` | `task_id` | the agent reads its own card |
| `kanban_heartbeat` | `task_id`, `note` | current activity during long work |
| `kanban_comment` | `task_id`, `body` | a durable progress note |
| `kanban_block` | `task_id`, `reason`, `kind` ∈ `dependency\|needs_input\|capability\|transient` | why it stopped; `needs_input` is a request for a person |
| `kanban_request_review` | `task_id`, `summary`, `metadata` | the result is ready for review |
| `kanban_complete` | `task_id`, `summary`, `result`, `metadata`, `artifacts[]` | an explicit outcome with artifact paths |
| `kanban_create` / `kanban_link` | `title`, parent/child | ordered plan steps as linked child cards |

They are deliberately absent from an ordinary session's schema. They enter it
when the active profile enables the `kanban` toolset — a key in the per-project
Hermes configuration, which the Node owns and writes.

Crucially, these tools do not call out to any server. They write to
`kanban.db`, a SQLite database inside the agent's own Hermes home. Each
Asterism project already has its own Hermes home and therefore its own board,
created and empty today:

```
/var/lib/asterism/hermes-projects/<project>/kanban.db
```

So the reporting path needs no credential for the agent at all.

### The bridge

```
agent  --kanban tool call-->  project's kanban.db  --read-->  Node
                                                                │
                                              existing authenticated channel
                                                                ▼
                                                         Control Plane
```

The Node already reads every project's Hermes databases and already holds the
only authenticated channel to the Control Plane. It reads new board rows
(`tasks`, `task_events`, `task_comments`, `task_attachments`) and forwards them
as a structured task report. The agent never receives a Control Plane
credential, and nothing outside the Node can submit a task report.

### Proving a report belongs to the Task and the Run

A project-local database proves almost nothing on its own. Everything with
filesystem access to that home can write a row into it, including the agent
itself, and a row can name any task it likes. So the association is never taken
from the board's content.

When the Node starts a Task's Run it **mints** the card: it generates a card id
that exists nowhere else, writes the mirror card under that id, and records the
binding in its own registry — `(card_id, task_id, run_id, generation)`, in the
Node's SQLite, which the agent's home cannot reach.

Reading the board then works in one direction only:

1. the Node looks up the binding for the Run it is currently executing;
2. it reads **only** the card with that minted id, and the rows beneath it;
3. it stamps the forwarded report with the task id, run id and generation **from
   its own binding**, never from anything the board said.

A card the agent invented, or a row naming another Task, is not the minted card
and is never forwarded. The agent's prompt still names its card id, but that is
addressing, not authority.

On the Control Plane side a report is accepted only when the Node owns the
project, the Task belongs to that project, the Run is one of that Task's Runs,
the generation matches the Task's current one, and the version the Node observed
is still the Task's version. Anything else is **rejected and recorded as a
rejected request** rather than applied.

Because the forwarder is at-least-once, every forwarded row carries its own
identity and lands through a unique constraint: a replayed delivery is a no-op,
not a second event. Successive Runs of the same Task each mint their own card,
so a late report from the previous Run fails the binding lookup, the run check
and the generation check independently.

### Delivery, and why a socket write is not enough

A report goes into the Node's `outbox` — the queue that already exists for
messages that must survive a reconnect — and the board cursor advances **in the
same SQLite transaction**. Commit means the report is durable and the row will
not be read again; rollback means neither happened and the next pass finds the
row still there. The cursor can never be past a report that was never queued,
which is the only way a `kanban_complete` could be lost for good.

The report is acknowledged by the Control Plane only after its own transaction
commits, and the Node keeps resending until it sees that acknowledgement.

A run's last `kanban_complete` is usually written moments before it ends, so the
board is read once more immediately before a run-ending event is forwarded.

### Ownership is settled before anything is written

A refusal reason is shown in a Task's own history, so the Control Plane
establishes that the reporting Node owns the Task's project **before** it writes
anything at all — including the record that the report was seen. A foreign
report is acknowledged, counted and logged, and leaves no trace in a project it
does not belong to. Retransmission is stopped by the acknowledgement, not by the
record, so nothing is needed in the database to make a stranger go away.

### Three outcomes for a task attachment, not two

A `runs.create` with no `task` is an ordinary run. One whose `task` cannot be
read is **refused before execution** with a typed reason; running it as an
ordinary run would do somebody's work with no record of which Task it belonged
to, and the Task would sit untouched while the run reported success. One that
reads is a task run, and its card is minted before the work starts.

If the card cannot be minted, or the binding cannot be recorded, the run is
preserved and executed and the failure is logged. What is lost is the
reporting, and the Control Plane learns that from the absence of reports rather
than from a claim.

### One safety change this forces

Every `hermes gateway` process starts a kanban dispatcher watcher, gated by
`kanban.dispatch_in_gateway`, which **defaults to true**. The Node runs
`hermes gateway` per project. Nothing has been affected so far only because
every board is empty. The moment Asterism writes a card, that dispatcher would
claim it and spawn its own worker — outside Asterism's run path, credential and
model selection, single-flight rule, approval policy and audit.

So there are two independent protections, and each is tested on its own with
the other assumed broken:

1. the Node writes `kanban.dispatch_in_gateway: false` into every project's
   Hermes configuration, so the watcher never claims anything;
2. the mirror card is created in a state the dispatcher cannot claim even if it
   is running.

Neither may be the reason the other's test passes. A protection that is only
load-bearing in combination is one accident away from a second executor, and a
second executor would run work outside the credential, model, single-flight,
approval and audit path that the rest of this product is built on.

### What is reported versus what is shown

Plan steps come from linked child cards, verified by the kernel. They are a
representation of a plan, never separately executed: Asterism creates no Run for
a plan step. Automatic decomposition into independently executing subtasks is
out of scope.

### When the Node cannot report at all

The bridge is advertised as a capability, `workdesk.structured_reports`, and
read as one: only an explicit `true` counts. It is never inferred from the
Node's version, and never from its willingness to accept a `runs.create` with a
task attached — a build that predates the bridge accepts that command, ignores
the field it does not know, runs the work and reports nothing.

When the capability is absent the console says so in as many words: the tasks
still run, but there is no plan, no step-by-step progress and no automatic
completion, and a run that succeeds goes to review. A Node that has the bridge
but is offline gets a different sentence, because sending somebody to upgrade a
machine that is merely unreachable wastes their afternoon.

Activity wording is only as strong as its evidence. Tool names are real —
`tool.started` carries the tool's actual name — so "Running a tool: terminal" is
honest. `tool.started` carries only a rendered label, not the call's arguments,
so nothing infers "editing files" or "running tests" from it. Anything the agent
said about its own activity is labelled as agent-reported. Technical events stay
available; `message.delta` is not the progress presentation.

## Authorization and Trash

The existing project and Node access checks apply unchanged. A project in Trash,
or under a Node in Trash, cannot have task work created and cannot have queued
work dispatched; both are refused at the request boundary and again at dispatch.
Task history stays readable through the authorized historical views, the same
way a trashed project's conversation stays readable. Restoring a project does
not run anything that was queued while it was away.

Completion, runtime approval and a request for input stay three different
things. Moving a Task to `completed` approves no tool operation.

## The Trello boundary, for later

Trello is the first planned Workflow Provider and is not implemented here. The
Task model stays independent of any external board, and the boundary is fixed
now so the adapter has one shape to fit:

- **Outgoing**: Task state is projected into an external representation. The
  projection is derived; it is never the source.
- **Incoming**: a board action becomes an authorized request, subject to the
  same checks as a request from a person. An external provider cannot write Task
  state.
- **Idempotency**: a delivery carries an identity, and a duplicate delivery must
  not produce a second execution.

No adapter scaffolding, provider catalog or unused table is added before there
is an adapter to put in it.
