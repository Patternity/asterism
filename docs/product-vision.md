# Product vision

What Asterism is for, the words it uses, and the direction its architecture is
accepted to take.

This document is about intent and terminology. `docs/architecture.md` is the
authority on how the components actually behave, and `docs/deployment.md` on how
they are operated. Where this document describes something as a direction rather
than a capability, the status table at the end says so explicitly.

## The statement

> Asterism
>
> The tools already exist. Asterism brings them together into a constellation
> built around your intent.
>
> Инструменты уже существуют. Asterism объединяет их в созвездие, выстроенное
> вокруг вашего замысла.

The metaphor is load bearing, so it is worth being precise about it.

Individual tools, agents and infrastructure components are the stars. They are
already there, already good, and already independently useful. Asterism connects
them into one engineering system that can be observed and controlled, and the
user's intent is what gives that system its shape and direction.

An asterism, in the astronomical sense, is a recognizable pattern of stars. It
is not necessarily an officially defined constellation. The pattern is real and
useful without being a formal boundary, which is close to what this product
does.

Asterism does not diminish itself by saying it "does not create a product". Its
product is the orchestration: ownership, authorization, durable state and
observability that make existing technologies operate as one system rather than
as a pile of tools that happen to be installed on the same host.

## Terminology

These words have specific meanings here. Using them loosely is how a product
starts promising something it does not do.

### Intent (намерение)

The direction of will and the desired outcome, as they exist before the system
has decided how to achieve them. Intent belongs to the user. It is not yet an
implementation plan.

### Prompt (промпт)

The user-visible formulation through which intent is communicated to Asterism.
A prompt carries intent; it is not the whole durable state of a task, and it is
not the intent itself.

The Russian spelling is `промпт`, not `промт`.

### Interpreted intent (понятый системой замысел)

The system's structured understanding of the result the user wants, arrived at
by reading the prompt together with the project context, the applicable policies
and the capabilities actually available.

In Russian product copy, `замысел` is preferred over repeating the more abstract
`намерение`, because it reads naturally in a sentence.

### Plan

The executable decomposition produced from the interpreted intent.

### Execution

The work actually performed by Hermes, by tools, and by delegated executors.

### Result

The observable working outcome. A successful model response is not a result. A
change that runs is.

### The sequence

```text
Intent
-> Prompt
-> Interpreted intent
-> Plan
-> Execution
-> Working result
```

```text
Намерение
-> Промпт
-> Понятый системой замысел
-> План
-> Выполнение
-> Работающий результат
```

## Architecture

The chain of responsibility:

```text
Asterism Control Plane
-> Asterism Node
-> project-scoped Hermes Runtime
-> tools and delegated AI executors
```

### Asterism Control Plane

Owns durable product state: organizations, users and permissions, Nodes,
projects, runs and attempts, commands and results, audit, policies and
organizational knowledge, capability negotiation, and the state a user can see.

It decides what should happen, who is allowed to ask for it, and which
boundaries apply.

### Asterism Node

The trusted execution boundary on a connected host. It represents the host to
the Control Plane, owns the local project inventory, resolves a project to its
exact runtime, supervises local workers, executes typed commands, reports its
capabilities and outcomes, and fails closed when a project's runtime is
unavailable.

It is not an unrestricted remote shell with a nicer protocol.

### Hermes Runtime

Hermes is the permanent primary runtime agent and orchestrator for a project. It
receives project-scoped work from the Node, works in the project's selected
workspace, owns the project's agent memory and sessions, plans and performs the
work, invokes local tools, may delegate bounded subtasks to other installed AI
agents, and verifies and integrates what those subtasks return.

Claude Code, Codex CLI and Gemini CLI are not replacements for Hermes in this
architecture.

### Delegated AI executors

Claude Code, Codex CLI, Gemini CLI, future agents and local models are
interchangeable internal executors that Hermes can call:

```text
Hermes
├── Claude Code
├── Codex CLI
├── Gemini CLI
├── local models
├── shell
└── project tools
```

Hermes may pick different executors for architecture analysis, implementation,
review, documentation or other bounded work. Asterism should not need a separate
provider-specific Control Plane integration for each one.

When Hermes changes which executor it delegates to, the project keeps its
identity, workspace, Hermes memory, run history, policies, organizational
knowledge and infrastructure relationships.

Interchangeable does not mean equivalent. Executors differ in capability, and
switching between them is not lossless: context, conventions and intermediate
reasoning do not transfer perfectly.

## Host Runtime, as a direction

Shared host infrastructure is a different concern from project work, and it is
intended to become a separate runtime scope. It does not exist today.

Its intended responsibility is the shared VPS: nginx, UFW, apt packages,
language runtimes such as nvm, systemd, host-level Docker configuration,
occupied ports, deployment conventions, operational incidents, and host-level
operational memory.

The intended boundary:

```text
Project Runtime
-> produces a typed infrastructure request
-> Asterism applies policy and approval
-> Host Runtime changes shared host infrastructure
-> the result returns to the project
```

A future Host Runtime may change shared host infrastructure but must not edit
project source workspaces. A project runtime may change its own project but must
not quietly acquire general host administration authority.

## Chat first

The primary interface is conversation:

```text
Chat
-> Task
-> Working result
```

The promise is not a browser IDE, a terminal dashboard, a Git client, or a live
feed of every internal agent event. The promise is that someone can describe an
intended result in ordinary language and Asterism can produce real work on
connected infrastructure.

Everything underneath stays inspectable, through progressive disclosure rather
than through a wall of events:

```text
Chat
-> Run
-> Attempt
-> Agent activity
-> Delegated executors
-> Tools
-> Commands
-> Files
-> Diff
```

Raw technical events are not discarded to achieve this. Asterism needs both a
normalized, human-readable progress projection and the complete technical event
history that diagnosis and audit depend on.

> Minimum effort outside, minimum necessary complexity inside, full
> inspectability at every layer.

## Reuse proven technologies

> Asterism builds orchestration, ownership and observability.
> It reuses proven tools for editing, terminals, version control, process
> supervision and deployment.

Rebuilding mature infrastructure needs evidence that integrating it is
insufficient. Without that evidence, integration wins.

| Need | Existing technology | Asterism responsibility |
| --- | --- | --- |
| Source history and branches | Git | ownership, task mapping and lifecycle |
| Concurrent working copies | Git worktree | allocation, leases, recovery and cleanup |
| Full browser IDE | code-server | authorization and opening the correct workspace |
| Browser terminal | a maintained Web SSH solution | authorized short-lived project access |
| Process supervision | systemd | exact unit lifecycle and health |
| HTTPS and routing | nginx | controlled publication and policy |
| Pull requests and CI | GitHub API or `gh` | task association and status |
| Agent orchestration | Hermes | planning, delegation and verification |

These are directions, not selections. No Web SSH package has been chosen.

This is also not a claim that Asterism is a bag of third-party tools. Coordinating
them safely and coherently is the part that does not already exist.

## Human access

Planned entry points for a person:

```text
Chat
Open Terminal
Open Web IDE
```

The intended direction is to integrate a maintained Web SSH solution for
terminal access and `code-server` for the browser IDE, rather than building
Monaco, a PTY protocol and a bespoke Git interface without demonstrated need.
Every managed session should open in the correct project or task workspace,
authenticate through Asterism, and never hand the browser a reusable SSH
credential.

> Asterism does not build its own IDE.
> It provides managed access to the same working environment used by Hermes.

## Workspace safety

Initially a person and Hermes may share one project workspace, with an explicit
warning and a visible indication that a run is active.

Before genuine parallel writers are supported, managed workspaces are the
intended answer: Git worktrees, leases and explicit ownership. A future
Workspace Manager would track the project, the task and run, the branch, the
worktree, the active writer, the lease, Web IDE sessions, terminal sessions,
delegated executor sessions, dirty state, external modifications and whether the
workspace can be cleaned up.

Worktrees isolate working copies, branches and indexes. They do not
automatically isolate ports, databases, Docker Compose project names, system
services, caches, process environments or external directories. Those may need
allocation of their own later.

Attribution has a real limit:

> Asterism tracks the owners of managed sessions and detects unattributed
> external workspace changes.

If someone edits a workspace over their own SSH connection, Asterism can notice
that the workspace changed, but cannot always say who did it.

## Organization knowledge and policies

This is direction, not availability.

Organizational knowledge should belong to Asterism rather than to one model or
one Hermes profile. Four things are commonly conflated and should not be:

* **Instructions**: textual guidance for an agent.
* **Guards**: restrictions and requirements that are technically enforced.
* **Templates**: reusable files and project scaffolding.
* **Knowledge**: documentation, decisions, examples and known problems.

An instruction in a prompt is not a security policy. Calling it one is how a
guard that does not exist ends up on a diagram.

Repository files such as `AGENTS.md`, `CLAUDE.md`, CI workflows and lint
configuration may later be discovered and offered for import, but repository
content must not silently become organization policy.

An organization-wide task should eventually fan out into authorized
project-scoped runs, rather than granting one project runtime unrestricted
access to every repository.

## What exists today

Evidence-based, as of `master` at the commit that added this document.
Production is deployed at `81dd2a2` with database schema 5.

| Capability | Status |
| --- | --- |
| Chat, runs, attempts, approvals, replay | In the production release |
| Image attachments by URL and upload | In the production release |
| One Node, one project, one Hermes runtime | In the production release |
| Durable command journal and audit | In the production release |
| Project provisioning: schema, protocol, capability | Merged to `master`, not deployed |
| Per-project Hermes home, worker and port allocation | Merged to `master`, not deployed |
| Project-scoped routing that fails closed | Merged to `master`, not deployed |
| `New project` console flow and provisioning states | Merged to `master`, not deployed |
| systemd worker template `asterism-hermes@.service` | Packaged in the repository, not installed |
| Reserved `asterism-host` profile name and routing refusal | Merged to `master`, not activated |
| Host Runtime | Accepted direction, not implemented |
| Executor adapters for Claude Code, Codex CLI, Gemini CLI | Accepted direction, not implemented |
| Executor installation interface | Accepted direction, not implemented |
| Web Terminal | Accepted direction, no solution selected |
| `code-server` integration | Accepted direction, not implemented |
| Workspace Manager, leases, worktree per run | Accepted direction, not implemented |
| Organization policies, guards, templates, knowledge | Accepted direction, not implemented |
| Best-practice library | Speculative |
| Cross-project organization tasks | Speculative |

"Merged to `master`, not deployed" means the code and its tests are in the
repository and the checks pass, and that production has not yet been migrated or
switched to it. Nothing in the two rows about the host profile and the worker
template has run on the production host.
