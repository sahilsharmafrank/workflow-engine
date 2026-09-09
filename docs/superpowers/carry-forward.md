# Carry-forward notes

Known gaps and deferred decisions, recorded as they were found. Each names the
phase that should deal with it. This file exists because the execution ledgers
live in git-ignored scratch and do not survive a clean.

## From Phase 2 (queue drivers)

### ~~The outbound service-request contract is undesigned~~ (resolved, Phase 3)

**Resolution:** The outbound dispatch remains a `WorkflowMessage` with
`kind: "resume"`, which already carries `tenantId`, `runId`, `stepNumber`,
and `correlationId`. The step's captured inputs are available to the external
service via `GET /runs/:id` (which returns the full run including step inputs)
or by the external service reading the step row directly. The reply path is
`PUT /runs/:id/callback` (HTTP) or publishing a `kind: "callback"` message
to `RESPONSE_QUEUE` (queue). A richer request envelope (carrying step inputs
inline) is a Phase 4 enhancement once real external-task integrations provide
feedback on what additional fields they need.

### ~~The spec contradicts itself about who consumes service queues~~ (resolved, Phase 3)

**Resolution:** Spec §3.1 amended to state that `WorkflowWorker` subscribes to
the delay queue and response queue only. Per-service request queues are outbound:
the engine publishes to them, external services consume them independently. The
earlier text listing "per-service request queues" among the engine's subscriptions
was marked as inherited from the original `remote-agent-response-listener` and
corrected.

### ~~pg deprecation warning~~ (resolved, Phase 3)

**Resolution:** The overlapping query was not in the `saveChecked` locking
path — `node --trace-deprecation` traced it to `RunExecutor.restartFromStep`.
`WorkflowRun.stepRuns` cascades (`cascade: true`), and restarting from an
early step resets it and every step after it, so a single `save(run)` handed
TypeORM's `SubjectExecutor` more than one UPDATE subject (the run plus
several steps). `executeUpdateOperations` fires those with `Promise.all`,
and every subject in one `save()` call shares the same underlying `pg`
`Client`, so the second query started before the first's response had
arrived — `pg` queues it rather than failing, but logs the deprecation.
Fixed by adding `RunRepository.saveWithSteps`, which persists each modified
step sequentially inside a transaction before saving the run (with
`stepRuns` temporarily cleared so it isn't cascaded a second time). Suite
output is now clean — verified with
`npm run build && npm test 2>&1 | grep -i deprecation` (no output).

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
