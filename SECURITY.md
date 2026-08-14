# Security Policy

## Supported versions

Asterism is **pre-release**. There are no published releases, no version tags,
and no backport policy.

| Version | Supported |
| --- | --- |
| `master` | Yes — fixes land here |
| Anything else | No |

Only the current `master` receives security fixes. Do not deploy this to
anything you cannot afford to rebuild.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through **GitHub Security Advisories**: open the repository's
**Security** tab and choose **Report a vulnerability**. Private vulnerability
reporting is enabled, so that channel is private to the maintainers and lets us
coordinate a fix before anything becomes public.

This file deliberately does not publish an email address, because none has been
designated for security reports. Use the advisory flow.

Please include:

* what you did, in enough detail to reproduce;
* what you expected and what happened instead;
* which component the issue is in — Control Plane, Node, console, or protocol;
* the impact you believe it has.

**Never paste a credential into a report.** If a credential was exposed, say
*which credential class* was exposed and where — for example "a provider OAuth
token in a run event payload". Do not include the value. If you believe a real
credential leaked, revoke it first, then report.

## Classify the issue at the right layer

Asterism runs agents inside **Hermes**, which is a separate upstream project.
Asterism does not implement the agent loop, the tools, provider integration, or
execution behavior, and does not add a security boundary inside Hermes.

Before reporting, reproduce the issue and determine which layer it belongs to:

* **Asterism** — Node identity handling, Control Plane authentication, sessions,
  RBAC, tenant isolation, the outbound protocol, command dispatch, run and event
  handling, host separation, project-to-project isolation.
* **Hermes** — the agent loop, tool execution, model calls, memory, and anything
  a model-generated command does inside a single project container.

An issue that reproduces inside the Hermes runtime belongs to that project.
Report it there. We will still want to know about it, but Asterism cannot fix it
and will not pretend to.

## Security boundaries

Asterism enforces:

* **Node identity** — Ed25519 private key, `0600`, never leaves the Node home,
  never enters a container. Rotation preserves `node_id` and increments a
  generation counter.
* **Control Plane secrets** — never present on a Node or in a project container.
* **Host separation** — a project container has no Docker socket and no access to
  the Node home, the run registry, or the Node private key.
* **Project-to-project isolation** — separate containers, workspaces, credential
  stores, and host ports.
* **Tenant isolation** — enforced by composite foreign keys in the database, not
  only in application code. Foreign tenant identifiers resolve as 404.
* **Browser session security** — Argon2id password hashing, digest-only session
  storage, HttpOnly/SameSite cookies, exact-Origin and CSRF enforcement,
  throttled login, immediate revocation.

Asterism explicitly **does not** claim isolation between Hermes and the code
Hermes executes. A project container is one trust domain. See
[`docs/trust-model.md`](docs/trust-model.md).

## Disclosure and licensing are separate

This repository is public so that its source can be reviewed. That says nothing
about licensing: no software license has been selected, and public visibility
grants no rights to use, copy, modify, redistribute, or host Asterism. See
[License status](README.md#license-status).

Reviewing the source to find and report a vulnerability is exactly what the
public repository is for, and reporting one is welcome regardless of the
licensing status.

## Secret handling rules

These apply to code, tests, documentation, commits, issues, and pull requests.

1. **Never commit a credential.** Not in source, not in a fixture, not in a test,
   not in a comment, not in documentation, not in a screenshot.
2. **Never commit runtime state.** `.asterism/`, `.env`, `auth.json`, `*.key`,
   `*.pem`, databases, WAL/SHM files, dumps, logs, and browser storage state are
   all excluded by `.gitignore` and by the CI hygiene check.
3. **Store only digests.** Enrollment tokens, rotation tokens, invitations,
   session tokens, and CSRF tokens are stored as SHA-256 digests. Plaintext is
   returned exactly once, at creation.
4. **Never log a credential.** Both the Node and the Control Plane redact by key
   name and by value shape. A number or boolean is never redacted — token
   *counts* are telemetry, not secrets.
5. **Tokens travel out of band.** Enrollment and rotation tokens are read from
   stdin, never from `argv`, so they do not reach the process table or shell
   history.
6. **Report presence, not value.** Credential scans emit verdicts such as
   `SECRET_FILE_EXCLUDED` or `CLEAN`. They never print what they found.

If you discover a credential in the repository or its history, treat it as
compromised: revoke it, then report privately. Do not delete the evidence before
telling a maintainer.

## Automated scanning

This repository is public, so GitHub Free provides these at no cost, and all of
them are enabled and verified:

* **Secret scanning** — GitHub scans commits for known credential formats.
* **Push protection** — a push containing a recognised credential is blocked
  before it lands.
* **Dependabot alerts** and **Dependabot security updates**.
* **Private vulnerability reporting.**

Push protection is a safety net, not a substitute for care. It only recognises
patterns GitHub knows about; it will not catch a project-specific token, a
database dump, or a Node private identity. `scripts/repo-hygiene.sh` runs in CI
and covers those deterministically. Both can be wrong; you cannot.

## Known limitations

* The deprecated Phase G `/v1` operator surface uses a single shared bearer
  token. **It is not user authentication.** It is disabled by default in
  production, restricted to the bootstrap organization, and every authenticated
  use is audited.
* Native Codex App-Server support is experimental and disabled by default; its
  approval-forwarding path is incomplete, so approvals raised under it never
  reach an operator.
* Identity rotation has no grace window. The superseded key stops working
  immediately.
* No load or failure-injection testing has been performed.
