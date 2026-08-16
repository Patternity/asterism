# Installing Asterism on a VPS

This installs one Asterism Node and one host-native Hermes on a server you
control, enrolls the Node with a Control Plane, and registers the project as an
externally managed runtime.

**Asterism has published no stable release.** Everything below describes a
prerelease. Interfaces, paths, and the installer itself may change without a
migration path.

## Supported platforms

```text
Ubuntu 24.04 LTS
Debian 12 (bookworm)
Debian 11 (bullseye)

linux/amd64
systemd
```

Nothing else is supported. The installer detects and refuses other
distributions, other releases of these two, other architectures, and hosts
without systemd. ARM, macOS, and non-systemd distributions are **not** supported
— not "untested", not supported.

Debian is supported because the whole runtime stack was tested on it, not
because it resembles Ubuntu. What had to hold: the Node.js the Codex CLI runs on
needs glibc 2.28 and bullseye ships 2.31; the `uv`-managed interpreter resolves
to the same version with the same SQLite; and Docker publishes a Compose plugin
for both codenames. The installer selects the Docker repository by distribution
— bullseye packages do not exist under the Ubuntu path.

Debian 11 reaches end of LTS in August 2026. It is supported now; that date is
not far away.

## What gets installed

```text
VPS
├── asterism-node.service      outbound WebSocket to the Control Plane
├── asterism-hermes.service    agent runtime, loopback only
├── project workspace
└── Docker Engine              the project's own services
```

One project, one VPS, one Node, one Hermes. Hermes listens on loopback and the
Node reaches it there; no inbound public port is opened by this installation.

## Before you start

The installer needs roughly **12 GB free** and a while to run. Most of it is one
download: extracting Hermes and the Codex CLI means pulling the pinned runtime
image, which is several gigabytes. That cost buys traceability to an artifact
Asterism has already accepted rather than to a version number, and it is paid
once.

## Running it

The script is meant to be read before it is run as root:

```bash
curl -fsSLO https://raw.githubusercontent.com/Patternity/asterism/master/scripts/install.sh
less install.sh
sudo bash install.sh
```

The one-liner does the same thing without the reading step:

```bash
curl -fsSL https://raw.githubusercontent.com/Patternity/asterism/master/scripts/install.sh | sudo bash
```

Both are interactive. Prompts read `/dev/tty` rather than standard input, which
is what keeps the piped form usable — in that form stdin is the script itself,
and a prompt reading it would consume the program mid-execution.

You will be asked for the Control Plane URL, a Node display name, a project
identifier, a workspace path, and a one-time enrollment token. The token is read
without echo and passed to the Node on standard input; it never appears as a
command-line argument, so it stays out of the process table and out of shell
history.

## Installed paths

| Path | Contents | Mode |
| --- | --- | --- |
| `/usr/local/bin/asterism-node` | Node binary from the release artifact | `0755 root:root` |
| `/etc/asterism/asterism.env` | Hermes API key, endpoint, Node home | `0640 root:asterism` |
| `/etc/asterism/install-metadata.json` | resolved versions; no secrets | `0640 root:asterism` |
| `/var/lib/asterism/node/` | Node identity, registry, run journal | `0700 asterism` |
| `/var/lib/asterism/hermes/` | Hermes state, config, provider credentials | `0700 asterism` |
| `/opt/asterism/hermes/` | pinned Hermes source and its virtualenv | `asterism` |
| `/opt/asterism/codex/` | pinned Codex CLI and the Node.js it runs on | `root`, world-readable |
| `/opt/asterism/bin/uv`, `/opt/asterism/python/` | pinned `uv` and interpreter | `root` / `asterism` |
| `/srv/asterism/workspace/` | the project workspace | `0755 asterism` |
| `/etc/systemd/system/asterism-{node,hermes}.service` | units | `0644 root:root` |

Node and Hermes run as the same unprivileged `asterism` user. That is deliberate:
the entire VPS is one project trust domain, and an agent that runs project
commands in the workspace and drives the project's Docker daemon is already
inside it. A second account would imply a boundary Asterism does not enforce.
See [`trust-model.md`](trust-model.md).

## Docker

Hermes manages the project's own services — the application, PostgreSQL, Redis,
whatever the project deploys — through Docker Compose. Docker is therefore a
requirement, not an option.

If Docker is absent the installer adds the official Docker apt repository and
installs Docker Engine with the Compose plugin. If Docker is already present it
is left alone; only daemon health and Compose availability are checked. The
`asterism` user is added to the `docker` group.

Hermes talks to the host daemon directly. Docker-in-Docker is not used: a nested
daemon would give the agent containers nothing on the host could see or manage.

**PostgreSQL is not an Asterism dependency.** Neither Node nor Hermes needs it.
A project may run PostgreSQL in its own Compose stack; that is the project's
concern.

## SQLite policy

Hermes keeps its state in SQLite, and Asterism does not change that.

SQLite versions 3.7.0 through 3.51.2 contain the [WAL-reset
bug](https://sqlite.org/wal.html#walresetbug), fixed in 3.51.3 and backported to
3.50.7 and 3.44.6. This threshold is not a guess — it is transcribed from the
pinned Hermes 0.20.0 implementation
(`hermes_cli/sqlite_runtime.py: is_sqlite_wal_reset_vulnerable`).

The installer probes the interpreter Hermes will actually run, not the system
Python, and:

* confirms FTS5 works by creating a real virtual table and querying it — a build
  can advertise the option and still fail to create the table;
* enables `journal_mode: wal` when the linked SQLite is past the bug;
* configures `journal_mode: delete` — Hermes' own supported fallback — when it is
  not, and says so;
* fails if neither mode is safe;
* refuses to place Hermes state on NFS, SMB, or FUSE.

**On every supported platform today the effective mode is `delete`.** No
python-build-standalone release currently links a fixed SQLite: the newest one
`uv` offers links 3.50.4; Ubuntu 24.04's own Python 3.12 links 3.45.1 and
Debian 11's Python 3.9 links 3.34.1 — all affected. The container runtime image sidesteps this by compiling SQLite 3.53.4
itself; a host install does not compile SQLite on your server. DELETE costs
write/read concurrency inside Hermes; it does not lose data.

The effective version and mode are reported at the end of installation and
recorded in `/etc/asterism/install-metadata.json`.

## Pinned components

Every version is fixed and recorded in the installation metadata:

| Component | Pin | Source |
| --- | --- | --- |
| Asterism Node | release tag | GitHub release, SHA-256 verified before install |
| Hermes | 0.20.0 | source tree extracted from the digest-pinned runtime image |
| `uv` | 0.11.6 | the version the accepted image was built with |
| Python | 3.13.13 | `uv`-managed; pyproject requires `>=3.11,<3.14` |
| Dependencies | `uv.lock` | `uv sync --frozen`, extras `all` and `otlp` |
| Codex CLI | 0.147.0 | extracted from the same pinned image, with its Node.js |

Hermes comes from
`ghcr.io/patternity/asterism-project-runtime@sha256:1d280b65…`, the artifact
Asterism has accepted, rather than from PyPI. A version number could resolve to
different content tomorrow; a digest cannot. The image's own virtualenv is not
copied — it links an interpreter that does not exist on your host — so only the
source and the lock travel, and the environment is rebuilt from that lock.

The extras are a strict subset of the image's set. Upstream's policy note in
`[project.optional-dependencies]` is that the omitted ones are lazily installed
at first use; `[all]` carries `[sms]`, which is what provides `aiohttp`.

Rust is never compiled on your VPS. The Node arrives as a versioned
`linux/amd64` archive built by GitHub Actions, and the installer verifies its
SHA-256 against the release's `SHA256SUMS` before writing anything.

That archive is built inside Debian 11 so its glibc floor is 2.31 — low enough
for every supported platform. A binary linked on a newer distribution installs
perfectly and then fails at every invocation, so the installer also *runs* it
once and refuses to continue if it cannot start. A checksum proves the bytes
arrived intact; it says nothing about whether they can execute here.

## Provider authorization

The project is configured for `openai-codex` with manual approvals. Hermes
reaches that provider by spawning the **Codex CLI**, which the installer extracts
from the same pinned image along with the Node.js it runs on — so neither becomes
a host dependency and neither resolves to whatever npm serves that day.

The installer runs the real device authorization as the `asterism` user:

```bash
codex login --device-auth
```

Codex prints a URL and a code. You open the URL in any browser, enter the code,
and approve. Nothing is pasted back into the terminal and no token is printed.
The credential lands in `/var/lib/asterism/hermes/.codex/auth.json`, mode `0600`.

`--device-auth` is the only headless path. The default `codex login` opens a
browser against a local callback server, which a VPS over SSH cannot use.

To do it later, or to re-authorize:

```bash
sudo -u asterism env HOME=/var/lib/asterism \
    CODEX_HOME=/var/lib/asterism/hermes/.codex \
    /opt/asterism/codex/bin/codex login --device-auth
```

Check the current state:

```bash
sudo -u asterism env CODEX_HOME=/var/lib/asterism/hermes/.codex \
    /opt/asterism/codex/bin/codex login status
```

## Service management

```bash
sudo systemctl status  asterism-hermes asterism-node
sudo systemctl restart asterism-hermes asterism-node
sudo systemctl stop    asterism-node asterism-hermes
sudo systemctl enable  asterism-hermes asterism-node   # already enabled
```

Hermes starts before the Node, and the Node retries rather than assuming
ordering means readiness. Both restart on failure and start at boot.

## Logs

```bash
journalctl -u asterism-node -u asterism-hermes -f
journalctl -u asterism-hermes --since "1 hour ago"
journalctl -u asterism-node -p err
```

Secrets do not appear in unit command lines, so `systemctl show` and
`systemctl cat` are safe to paste into a bug report. The Hermes API key lives
only in `/etc/asterism/asterism.env`.

## Status and diagnosis

```bash
sudo bash install.sh --doctor
```

Reports platform, binaries, credential file mode and ownership, unit state,
Hermes health, the Hermes bind address, and the recorded metadata. It changes
nothing — a diagnostic that repairs cannot be run safely on a host that is
already misbehaving.

Node-level checks:

```bash
sudo -u asterism asterism-node node status   --node-home /var/lib/asterism/node
sudo -u asterism asterism-node project list  --node-home /var/lib/asterism/node
sudo -u asterism env ASTERISM_NODE_HOME=/var/lib/asterism/node \
    asterism-node project status --project-id <id>
```

## Rerunning the installer

A second run is safe. It detects the existing installation and preserves the
Node identity, the Hermes API key, the provider credentials, the Hermes state,
and the workspace. It does not re-enroll or re-register. Missing units, binaries,
and permissions are repaired.

It will not silently replace anything it did not install. Conflicts are reported
rather than resolved by overwriting.

## Upgrades

Upgrading the Node:

```bash
sudo systemctl stop asterism-node
sudo ASTERISM_VERSION=vX.Y.Z bash install.sh
```

The identity, registry, and run journal are preserved; the binary is replaced
after its checksum is verified.

**Back up before a Hermes upgrade.** Hermes owns its own on-disk schema and
Asterism does not migrate it:

```bash
sudo systemctl stop asterism-hermes
sudo tar -C /var/lib/asterism -czf /root/asterism-hermes-$(date +%F).tar.gz hermes
sudo systemctl start asterism-hermes
```

Copy that archive off the VPS. It contains provider credentials — treat it as a
secret.

## Backups

What is irreplaceable:

| Path | Why |
| --- | --- |
| `/var/lib/asterism/node/` | Node identity — losing it means re-enrolling |
| `/var/lib/asterism/hermes/` | agent state and provider credentials, including `.codex/auth.json` |
| `/etc/asterism/asterism.env` | the Hermes API key |
| the workspace | your project |

```bash
sudo systemctl stop asterism-node asterism-hermes
sudo tar -czf /root/asterism-backup-$(date +%F).tar.gz \
    /etc/asterism /var/lib/asterism
sudo systemctl start asterism-hermes asterism-node
```

## Rollback limitations

There is no automatic rollback, and this is a real limitation rather than an
omission:

* the Node binary can be replaced with an older release, but the registry schema
  migrates forward only — an older Node refuses a newer schema by design;
* Hermes state has no downgrade path;
* enrollment is one-way; recovering a lost identity means enrolling again from
  the Control Plane.

Restoring from a backup taken before the upgrade is the supported way back.

## Manual removal

No automatic uninstall is provided. Removal destroys agent state and provider
credentials, and doing that from a script invoked in a hurry is how people lose
work. The steps, in order:

```bash
sudo systemctl disable --now asterism-node asterism-hermes
sudo rm /etc/systemd/system/asterism-node.service \
        /etc/systemd/system/asterism-hermes.service
sudo systemctl daemon-reload

# Back these up first if there is any chance you want them.
sudo rm -rf /var/lib/asterism /etc/asterism /opt/asterism
sudo rm -f /usr/local/bin/asterism-node

sudo userdel asterism            # leaves the workspace in place
# sudo rm -rf /srv/asterism      # the project workspace — only if you mean it
```

Docker is left installed: the installer does not know whether it was there
first, and removing a working Docker Engine because Asterism is leaving would be
presumptuous.

Remove the Node from the Control Plane separately, through the operations
console.

## Related documentation

* [`architecture.md`](architecture.md) — runtime ownership and what each
  component owns
* [`deployment.md`](deployment.md) — manual deployment and the container
  compatibility mode
* [`node-operations.md`](node-operations.md) — Node CLI reference
* [`trust-model.md`](trust-model.md) — what Asterism does and does not isolate
