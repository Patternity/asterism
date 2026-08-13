# Trust model

This document states plainly what Asterism protects, what it does not, and who
is responsible for what. Read it before connecting a Node to anything you care
about.

## The short version

A project container is **one trust domain**. The Node owner chooses what goes
into it: the repository, the Hermes runtime, and the provider credentials. Code
that runs inside that domain can reach everything else inside that domain.

Asterism protects the boundaries **around** that domain — Node identity, Control
Plane secrets, the host, and other projects. It does not place a boundary
**inside** it, and it does not reimplement Hermes.

## What the Node owner controls

* **The project.** The Node owner decides which repository a project points at.
  Asterism resolves a project id to a workspace path that only the operator ever
  supplied; a path arriving from the Control Plane is not part of the data model.
* **The provider credentials.** They are installed locally, in that project's own
  Hermes data directory, by the Node owner. They are supplied through
  `asterism-node project auth`, which runs the provider's own login flow inside
  that project's container.
* **What the agent is asked to do.**

**Credentials never travel through the Control Plane.** The Control Plane has no
field for them, never receives them, and never stores them. It addresses work by
project id.

## What one trust domain means

Inside a project container, Hermes owns the agent loop, the tools, and execution.
The credential store for that project is readable by the same OS user that runs
the model-generated commands.

This is measured, not assumed — see
[`phase-c-credential-isolation.md`](phase-c-credential-isolation.md) for the
evidence, and note the superseded-conclusion banner at the top of that file.

The consequence follows directly:

> **Code executed inside a project container is the Node owner's
> responsibility.** It can read the provider credentials that the Node owner
> installed for that same project.

Asterism **does not claim isolation between Hermes and the code Hermes executes.**
Any documentation, issue, or report that implies otherwise is wrong.

The practical rule is one of scope, and it is the rule Asterism is built to
support: **a project container must hold credentials for that project only.**
Never Control Plane credentials, never credentials for another project, never
credentials for another user.

## What Asterism does protect

| Boundary | How |
| --- | --- |
| **Node identity** | Ed25519 private key, `0600`, never leaves the Node home, never enters a container. Rotation replaces the key while preserving `node_id`. |
| **Control Plane secrets** | Never present on a Node or in a project container. Enrollment and rotation token values are stored only as SHA-256 digests and returned exactly once. |
| **Host separation** | A project container has no Docker socket, no access to the Node home, the run registry, or the Node private key. |
| **Project-to-project isolation** | Separate containers, workspaces, credential stores, and host ports. One project cannot read another's credentials or workspace. |
| **Tenant isolation** | Composite foreign keys `(organization_id, node_id)` make cross-organization relations impossible in the database itself. Foreign tenant identifiers resolve as 404. |
| **Browser session security** | Argon2id password hashing, PostgreSQL-backed sessions stored only as digests, HttpOnly/SameSite cookies, exact-Origin and CSRF enforcement, throttled login. |

## Running untrusted repositories

Pointing a project at a repository you do not trust carries **the normal risks of
executing untrusted code**. The agent will read it, build it, and run it, because
that is what it is for.

If you do that, assume the credentials in that project container are exposed to
whatever that repository can execute. Give that project its own throwaway
credentials, or do not give it credentials at all.

## Experimental runtime path

Native Codex App-Server support is **experimental and disabled by default**. Its
approval-forwarding path is incomplete: approval requests raised under it do not
reach the Asterism API, so an operator cannot see or answer them, and the run can
proceed on decisions nobody reviewed.

The supported default is the normal Hermes agent loop. Do not enable the native
path on anything that matters.

## Reporting a security issue

See [`../SECURITY.md`](../SECURITY.md). If an issue reproduces inside the Hermes
agent runtime itself, it belongs to that layer — classify it there rather than
reporting it as an Asterism boundary failure.
