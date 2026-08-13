# Contributing

## Language

**Everything committed to this repository is written in English** — source code,
comments, documentation, commit messages, branch names, issue titles and bodies,
and pull request titles and descriptions. No exceptions.

Conversation elsewhere can happen in any language. What lands in the repository
is English.

## Branch and pull request workflow

`master` accepts changes **only through pull requests**. Direct pushes and force
pushes are not permitted.

> **Enforcement status: policy only, not yet technical.**
>
> GitHub Free for organizations does not offer branch protection or repository
> rulesets on **private** repositories. Both the classic protection API and the
> rulesets API currently answer
> `403 Upgrade to GitHub Pro or make this repository public`, and
> `repos/Patternity/asterism/branches/master` reports `protected: false`.
>
> Until the organization moves to a plan that includes protected branches for
> private repositories, nothing on the server blocks a direct push. **Follow this
> workflow anyway.** `.github/branch-protection.json` holds the exact
> configuration to apply the moment the plan allows it; the remedy is recorded in
> [`docs/deployment.md`](docs/deployment.md).

```sh
git switch -c feat/short-description
# ... work ...
git push -u origin feat/short-description
gh pr create
```

Requirements before a pull request can merge — enforced by review discipline
today, and by the server once protection is available:

* CI passes — every required check;
* at least one approving review, from someone other than the last pusher;
* approvals are dismissed when new commits are pushed, so re-request review after
  changes;
* all review conversations resolved;
* the branch is up to date with `master`.

**Squash merge is the only enabled merge method.** History on `master` is linear
and one commit per pull request. Head branches are deleted automatically after
merge.

## Commit messages

Conventional Commits, single line, imperative mood:

```
<type>(<scope>): <description>
```

Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `build`, `ci`, `perf`,
`chore`. Scopes in use: `node`, `protocol`, `control-plane`, `web`,
`deployment`, or omit it when a change is genuinely cross-cutting.

```
feat(control-plane): add stranded run recovery endpoint
fix(node): resolve the Hermes endpoint per project
docs: document the trust model
```

Do not add tool or AI attribution trailers of any kind.

## Never commit

* credentials of any kind — provider tokens, API keys, passwords, private keys,
  session or CSRF tokens, enrollment or rotation tokens;
* `.env` files, `auth.json`, `*.key`, `*.pem`;
* runtime state — `.asterism/`, databases, WAL/SHM files, dumps, logs, browser
  storage state;
* build output — `target/`, `dist/`, `node_modules/`, `test-results/`;
* archives or snapshots of the source tree.

`.gitignore` covers these and `scripts/repo-hygiene.sh` fails CI if any of them
reach the index. If you find yourself arguing with the hygiene check, the check
is right.

Lockfiles are the exception that **must** be committed: `Cargo.lock`,
`control-plane/package-lock.json`, and `control-plane/web/package-lock.json`.

## Tests

A change ships with the tests that prove it. Run the full gate before opening a
pull request:

```sh
scripts/phase-h-acceptance.sh
```

That runs formatting, linting, strict typechecking, builds, unit tests,
integration tests, dependency audits, and mocked browser tests across all three
packages. It requires PostgreSQL and Chromium. See
[`docs/development.md`](docs/development.md) for per-package commands and
database setup.

Expectations:

* a bug fix comes with a regression test that fails before the fix;
* a new endpoint comes with integration tests including the negative cases —
  unauthenticated, wrong role, wrong tenant;
* a protocol change updates the specification, **both** implementations, and the
  cross-language fixtures;
* do not weaken, skip, or delete a check to make a build pass. If a check is
  wrong, fix the check in its own commit and say why.

Live acceptance (`PHASE_H_LIVE=1`) is an explicit opt-in operation requiring real
infrastructure. CI never runs it, and neither should you casually — see the
warning in `docs/development.md`.

## Architecture boundary

Asterism does **not** reimplement the Hermes agent runtime. Hermes owns the agent
loop, tools, provider integration, model calls, memory, approvals, and execution
behavior.

Pull requests that introduce a split runtime, a credential broker, a custom
executor, separate Hermes users, or any replacement for Hermes **will be
rejected** without a prior, explicit, recorded architecture decision.

This is not a style preference. Asterism's value is that it manages agents
centrally without becoming one; reimplementing the runtime would fork a boundary
that has already been measured and accepted. Read
[`docs/architecture.md`](docs/architecture.md) and
[`docs/trust-model.md`](docs/trust-model.md) before proposing anything in this
area.

Similarly: a project container is one trust domain, and credential readability
inside it is accepted, not a defect. Do not open pull requests that "fix" it.

## Security issues

Do not open a public issue. Follow [`SECURITY.md`](SECURITY.md).
