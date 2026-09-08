# Carry-forward notes

Known gaps and deferred decisions, recorded as they were found. Each names the
phase that should deal with it. This file exists because the execution ledgers
live in git-ignored scratch and do not survive a clean.

## From Phase 2 (queue drivers)

### The outbound service-request contract is undesigned

`publishSuspension` sends an `awaitCallback` dispatch to `wfe-service-<name>` as
a `WorkflowMessage` with `kind: "resume"` and no step inputs. That shape exists
because core used to consume the queue itself; nothing in core consumes it any
more. An external service reading that message learns the tenant, run, step and
correlation id, but nothing about what work to do.

Decide what an external consumer actually receives — probably a request envelope
carrying the step's inputs, distinct from `WorkflowMessage` — and how it replies:
`RESPONSE_QUEUE` with `kind: "callback"`, or the HTTP callback endpoint.

**Phase 3 or 4.** Blocks any real external-task integration.

### The spec contradicts itself about who consumes service queues

`docs/superpowers/specs/2026-09-07-standalone-workflow-engine-design.md` lines
62-63 have the engine publish to the service queue while external workers reply
on the response queue. Lines 70-71 list "per-service request queues" among the
engine's three subscriptions, inherited from an older engine's
`remote-agent-response-listener`.

Phase 2 resolved this in favour of the diagram: `WorkflowWorker` subscribes to
`DELAY_QUEUE` and `RESPONSE_QUEUE` only. Implementing the other reading — agents
replying on their own per-service queue — needs a *separate* reply-queue name,
because one queue cannot carry both directions without the engine consuming its
own dispatches. That was a real bug, caught in the final whole-branch review.

**Amend the spec** so the next phase does not re-derive this.

### pg deprecation warning

Full-suite output carries:

```
DeprecationWarning: Calling client.query() when the client is already executing
a query is deprecated and will be removed in pg@9.0
```

It appears under Phase 1 suites (`db/persistence`, `engine/start-workflow`), so
it predates Phase 2, but it sits next to the `SELECT … FOR UPDATE` locking path
and becomes a hard failure on `pg@9`. It is also the only thing keeping suite
output from being pristine.

**Phase 3.** Find the overlapping query and await it properly.

### `delay-step.ts` has no NaN guard

`Number(ctx.inputs.seconds ?? 0)` yields `NaN` for a non-numeric `seconds`. The
memory driver then fires immediately and SQS rejects the call. Definition-shape
validation is the right place to catch this rather than the step.

**Phase 3 or 4**, with the rest of definition validation.

### RabbitMQ driver, deferred minors

Recorded during Phase 2 review and consciously not fixed: an ack/nack-vs-close
race, bucket clamping rather than erroring on an over-cap delay, and holding-queue
name collisions between deployments sharing a broker. None are data-loss bugs;
all are worth a pass when the driver next gets attention.
