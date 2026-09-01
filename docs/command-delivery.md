# Command delivery

What happens to a command between the Control Plane deciding to send it and the
Node reporting what it did, and why the gap that remains is deliberate.

## What holds today

A command is durable before it is sent. The Control Plane records it, marks it
`dispatched`, and writes it to the Node's session. The Node admits it to its own
registry before executing anything, keyed by command id, so the same command
arriving twice executes once.

That is dispatch-once with deduplication. It is not at-least-once, and the
difference is the subject of this document.

## The gap

A session can end between `dispatched` and the Node's result. When it does, that
delivery is gone: nothing re-sends it, and the Node never recorded it, so neither
side is holding the work.

Production found this. Two runs were created in the same second, the Node's
registry answered `database is locked`, the session ended, and the command
inside it disappeared. Its run stayed `queued` for ever, and because a project
executes one run at a time, the project could not start another. Neither
recovery path reached that state: `cancel` refused because the Node had never
accepted the run, and `force-close` refused because the Node was online.

Two changes followed, and neither of them is delivery.

**The contention is fixed.** `admit_remote_command` began a deferred transaction,
read, and then needed to write. SQLite refuses that upgrade the moment another
connection has committed — immediately, in microseconds, without consulting
`busy_timeout`, because waiting while holding a read snapshot could deadlock.
Registry writes now take the write lock when they begin, which is what lets the
timeout do its job. A session is also no longer lost to a local storage failure:
the operation fails, the session stays.

**The consequence is bounded.** A command that is dispatched and never answered
is marked `indeterminate` after `commandTimeoutMs`, and its run becomes `lost`.
The project becomes usable again, and the audit keeps the indeterminate outcome
rather than a guess.

So a lost delivery is now rare and no longer permanent. It is still a lost
delivery.

## Why replay is a separate decision

Re-sending the command is the obvious next step and the reason it is not taken
here is that "send it again" is not one change:

**It changes what a Node may assume.** Today a command arrives once and the Node
deduplicates a repeat that the *Control Plane* chose to send. Replay makes a
repeat ordinary, which makes the Node's idempotency load-bearing for correctness
rather than a safety net. Every command type has to be examined against that,
not just the ones that are convenient to reason about.

**`indeterminate` is a real state, not a missing one.** A command that reached
the wire may have been executed. Replaying it means deciding, per command type,
whether executing twice is worse than not executing at all. For `runs.create`
that is a question about the user's money and the project's workspace, not about
transport.

**It needs a protocol, not a retry loop.** At-least-once without a delivery
receipt just moves the window: the Node must be able to say "I have this one"
before it acts, and the Control Plane must be able to ask. That is a protocol
version, a schema, and a migration for both sides.

**The safety net must survive it.** Whatever replay does, a command that truly
cannot be resolved still has to end, or a project is stuck again. The timeout
above stays either way, and its interaction with replay is part of the design
rather than an afterthought.

None of that is hard. It is simply larger than a storage fix, and shipping half
of it — a retry with no receipt — would replace a rare lost run with a rare
duplicated one, which is worse.
