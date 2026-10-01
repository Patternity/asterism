# Showing Asterism

A five-to-seven minute demonstration of the alpha, for invited users and for
the people who write about it. It is written to be run by somebody who has not
read any engineering history: every step says what to click and what should
appear.

Everything below has been performed against production in a browser. If a step
does not behave as described, stop and say so rather than improvising — the
point of the demonstration is that the product tells the truth.

## Before you start

1. **Have the console open** at <https://onsetexpo.textura.agency> and be
   signed out, so the demonstration starts where a new person starts.
2. **Make sure a credential is live, the day before if you can.** A credential
   can read as ready in the product and still have been revoked by the
   provider; the product finds out when a run fails, and then says so. Open the
   production host's page: a credential that says **Provider access ended**
   cannot run anything until somebody presses *Reauthorize* and approves a code
   in a browser. Do that first, then send one throwaway message in the
   disposable project and check it answers.

   > As of 2 October 2026 no credential on the production host reads *Ready*:
   > the two that were in use read *Provider access ended* because the
   > provider revoked them, and the older ones read *Revoked* or *Not held by
   > this Node*. Until one is reauthorized, every step below works except the
   > run — which fails visibly, with `HTTP 401` in the turn, exactly as it
   > should. Do not demonstrate until a credential answers.
3. **Check the disposable project exists and is active**: *Projects* →
   **Trash acceptance**. It is there to be moved to Trash in front of people.
   Never demonstrate on another project.
4. **Have both Nodes connected**: *Nodes* shows **Rurak** and the production
   host, both `online`. One of them (`node-2`, "Rurak") deliberately runs an
   older build; that is part of the story, not a fault.

Allow about a minute for a run to answer. Do not narrate over silence: the
console shows the turn as working, and that is worth pointing at.

## The demonstration

**1. Sign in (20s).** Email and password on the front page. You land on
*Overview*: counts of Nodes, projects, runs, and recent activity. Say what
Asterism is in one sentence: *it runs an agent on machines you own, and keeps
an honest record of what happened.*

**2. The machines (40s).** *Nodes* → open the production host. Point at:

- the reported version and the connection state — read from what the Node
  itself said, not guessed;
- **Capabilities** — the Node publishes what it can be asked to do, and the
  console only offers controls for those;
- **Providers** and **Provider credentials** — credentials live on the machine
  and never leave it; the console shows facts about them, never the secret.

Then open **Rurak**. It says *"This Node runs a build that cannot be updated
from here. Update it on the host itself."* and offers no update button. This is
the point to make: *the console refuses to offer what a machine cannot do.*

**3. A project, its account and its model (60s).** *Projects* → **Trash
acceptance**.

- **Model credential**: choose an authorized credential and press *Use this
  credential*. The worker is moved onto that credential and proven before the
  page says it took.
- **Model**: the list is what that Node reported it can run for that
  credential's provider — the console holds no model list of its own. Choose
  one and press *Use this model*.

**4. A real run (2 min).** In **Conversation**, type a small task, for example
`Reply with exactly: showcase ok`, and press *Send*. Point at the working
indicator, then at the answer when it arrives. Then *Runs* → the run is there
with its status and the model it actually used. This is the durable record: it
survives a reload, a restart and the browser being closed.

**5. Trash (90s).** Back on the project, press *Move to Trash*. Read the
confirmation aloud — it says the four things people ask: it leaves active
views, the data and history are kept, it is reversible, and no disk space is
freed. Confirm.

- The page moves to **Trash** immediately.
- *Projects* no longer lists it.
- Open its URL anyway: the page says it is in Trash and its conversation takes
  nothing.
- **Trash** shows it under its Node, and the Node is marked *Active — shown
  here only for the projects below*. This is the hierarchy: a project can be in
  Trash while its machine is not.

Press *Restore project*. It returns to *Projects*, its worker is started again
and proven, and the conversation accepts work.

**6. A whole machine (60s, optional).** On **Rurak**, press *Move to Trash* and
confirm. In **Trash** the Node appears as *In Trash, with every project on it*,
and each project under it says it is there *with its Node*. *Nodes* no longer
lists it. Press *Restore Node*: the machine and its projects come back.

Say the rule while restoring: *restoring a machine does not restore a project
somebody had put in Trash on its own.* That project keeps its own tombstone and
stays in Trash.

**7. Close (20s).** Return to *Overview*. The claim to land: nothing was
deleted at any point, the machine was never touched except to stop and start a
worker, and every state on screen came from the machine saying so.

## Safe data to use

| Use | Do not use |
|---|---|
| Project **Trash acceptance** on the production host | the project `prj_2b01…`, which carries the accepted credential and run history |
| **Rurak** (`node-2`) for the Node-in-Trash part | the production host for the Node-in-Trash part |
| Any credential the console lists as *Ready* | credentials in any other state — they cannot run anything |

Create a second disposable project rather than borrowing a real one if you need
more room. There is no permanent delete, so anything created stays.

## Not ready to be shown

- **Permanent deletion, retention, disk usage.** Trash keeps everything and
  frees nothing; there is no button that removes data, and no project size
  anywhere. Do not promise one.
- **Credential rotation.** Logging a credential in again is in the product;
  doing it on a schedule is not.
- **Per-run model choice.** A project has one model; a run records the model it
  used.
- **Anything about other organizations or invited-user permissions** beyond
  what is on screen.
- **The older Node's update path.** `node-2` cannot be updated from the console
  by design of its build; do not attempt it in front of anybody.

## Invite-only smoke checklist

Run this before letting a new person in, and again after any deployment:

- [ ] sign in, and the *Overview* counts render
- [ ] *Nodes* lists both machines as `online`
- [ ] the production host shows its version and capabilities
- [ ] `node-2` explains it cannot be updated from here, with no button
- [ ] **Trash acceptance** opens from *Projects*
- [ ] a credential can be assigned and the page confirms it took
- [ ] a model can be selected from the Node's own list
- [ ] one message is answered in the conversation
- [ ] the run appears in *Runs* as completed, with its model
- [ ] *Move to Trash* lands on Trash within a second or two
- [ ] the project is gone from *Projects* and takes no work
- [ ] *Restore project* brings it back and its conversation works
- [ ] *Trash* is empty at the end
- [ ] the browser console shows no errors after sign-in

## Known limitations that are not blockers

- **A credential's state is optimistic until something uses it.** The provider
  can revoke access without telling us; the product finds out when a run fails,
  and then moves that credential to *Provider access ended* and asks the Node
  again. Expect the first failure to be the discovery.
- **Restoring a project under a Node that is still in Trash is refused**, on
  purpose. Restore the Node first. The console says so and does not offer the
  button.
- **A Node whose build predates worker suspension** keeps its workers running
  when its projects go to Trash. The Control Plane still hides them and refuses
  their work, and the console says nothing on the host was changed.
- **Nothing is ever deleted**, so disposable demonstration projects accumulate.
- **`node doctor` reports a failed check while a project's credential is not
  authorized** — `credential reference invalid … (credential_unavailable)`.
  That is the truth, not damage: the project's link and credential home are
  intact, and the check passes again once the credential is authorized.

## Where production is

| | |
|---|---|
| Console | <https://onsetexpo.textura.agency> |
| Control Plane revision | `21d63eb67bcb06223dd9a2e61c554f9eb401082e` |
| Control Plane schema | 19 |
| Node release on the production host | `v0.1.0-alpha.37` (built from `5c4d940`) |
| Node registry schema | 10 |
| `node-2` | legacy `0.1.0`, deliberately not updated |

A revision written down goes stale. What is serving right now is on the host
itself, so check it rather than trusting this table:

```
docker inspect "$(docker ps --format '{{.Names}}' | grep -m1 control-plane-control-plane)" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

**Rollback.** Database and configuration backups are on the host under
`/var/backups/asterism/`. The most recent, taken immediately before the
revision now running, is `pre-name-fix/20260928T152850Z`; before it are
`pre-showcase/20260928T150842Z` and, before the Trash release,
`pre-trash/20260925T122148Z`. Each holds the Control Plane dump, the revision
it was taken at, the Node registry and the environment file. Rolling the
Control Plane back means redeploying the previous revision from
`/srv/asterism/deployment`; going back past the Trash release also needs
`019_hierarchical_trash.down.sql`. The Node is rolled back by asking for an
earlier release through the console.
