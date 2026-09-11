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

### ~~`delay-step.ts` has no NaN guard~~ (resolved, Phase 4)

**Resolution:** `DelayStep` now rejects anything that is not a finite,
non-negative number with a `WfeError` carrying `DELAY_INVALID_SECONDS` and a 400
status, naming the offending value. Guarding in the step rather than only in
definition validation is deliberate: `seconds` is an *expression result*, not a
literal in the definition, so validation at publish time cannot see what it will
evaluate to at run time.

## From Phase 4 (plugins, steps, snapshotting, batch jobs)

Small items deferred during Phase 4 review. None are correctness bugs in the
happy path; each is worth closing when its file is next touched.

- **Async plugin register path is untested.** `loadPlugins` awaits a plugin's
  register function, so a plugin returning a promise works, but no test covers
  it.
- **The sample plugin package declares no `@wfe/sdk` dependency.** It resolves
  through the workspace today; a real third-party plugin would need the
  dependency declared, so the sample sets a poor example.
- ~~**`EmitEventStep` does not validate an empty queue input.**~~ (resolved)
  An empty, whitespace-only, or non-string queue name is now a `WfeError`
  (`EMIT_EVENT_INVALID_QUEUE`, 400) rather than a publish to a queue named
  `""`. Fixed alongside `EMIT_EVENT_RESERVED_QUEUE` (see final-review-A.md
  Fix 1), which refuses `core.emitEvent` publishes to `DELAY_QUEUE`/
  `RESPONSE_QUEUE` — without it a workflow could forge engine control
  messages onto its own resume/callback queues.
- **`ConditionStep` silently skips on an unknown action value.** A typo in
  `action` behaves like a deliberate skip instead of erroring.
- **Definition snapshotting is a shallow assignment.** A deep clone would be
  safer against later mutation of the source definition object.
- **`retry`/`backoff` success path and `HTTP_STEP_MISSING_URL` are untested** in
  `core.http`.
- **`core.http`'s SSRF guard has a DNS-rebinding residual gap (open).**
  `assertHostAllowed` (`http-step.ts`) resolves and validates the hostname
  itself via `dns.lookup`, but the `fetch()` call that follows performs its
  own, independent DNS resolution when it actually opens the connection.
  That gap between the two lookups is a time-of-check/time-of-use window: a
  malicious or compromised DNS server can rebind the name to a blocked
  address after the check passes, and `fetch` will connect to it anyway.
  Closing it properly requires pinning the address this function validated
  into the socket `fetch` opens — e.g. a custom undici dispatcher with a
  `connect` override that forces the validated address while preserving the
  TLS SNI/Host header — which is out of scope for the current fix. Documented
  in README.md under `core.http` in [Built-in steps](../../README.md#built-in-steps)
  so a reader who never opens the source learns the guard raises the bar but
  is not airtight. A literal IP in the URL is not subject to this gap.
- **Step-write endpoints can race a running executor (deliberately
  deferred).** `PUT /api/v1/steps/:id/state`, `/inputs-outputs`, and
  `/priority` (`packages/server/src/controllers/steps.ts`) write `StepRun`
  rows directly, outside the executor's pessimistic `SELECT ... FOR UPDATE`
  locking path (see `RunRepository`), and `StepRun` has no revision column to
  detect a concurrent write. An operator call against a step the executor is
  actively processing can interleave with the executor's own write and
  silently clobber one or the other. Deliberately not fixed here: these are
  operator repair endpoints, the engine's own execution path is properly
  locked, and step-level locking is a migration (a revision column) plus
  repository surgery that belongs in its own change, not folded into an
  unrelated fix. Documented in README.md's
  [REST API](../../README.md#rest-api) section as administrative routes that
  can race a running executor.

### RabbitMQ driver, deferred minors

Recorded during Phase 2 review and consciously not fixed: an ack/nack-vs-close
race, bucket clamping rather than erroring on an over-cap delay, and holding-queue
name collisions between deployments sharing a broker. None are data-loss bugs;
all are worth a pass when the driver next gets attention.

## From Phase 5 (`@wfe/ui`, static serving, Docker)

### A batch job's own status is never set to `"complete"` (engine gap, not a UI one)

Verified by grep during Phase 5: the only writers of `BatchJob.status` are
`"running"` (on create), `"failed"` (the fan-out `catch`), and `"cancelled"`
(cancel) — all in `packages/server/src/controllers/batch-jobs.ts`. There is no
code path that ever writes `"complete"`. `computeProgress`'s own `"complete"`
check counts completed **runs** (a different field, on the batch job's
progress summary), not the job's `status`. Net effect: a batch job whose runs
have all finished stays `status: "running"` indefinitely, `@wfe/ui`'s Batch
Jobs screen shows it as perpetually in-flight, and it remains cancellable
forever even though there is nothing left to cancel. Fixing this belongs in
`@wfe/core`/`@wfe/server` (the engine needs to observe "all runs terminal" and
flip the job's own status) — no UI-side workaround was applied, because
inferring completion client-side from the progress counts would just be
re-implementing the same logic the server should own, in the wrong layer.

### `computeProgress` never buckets cancelled runs

For a cancelled batch job, the three progress counts (however they are
named/bucketed in `computeProgress`) can sum to less than `totalCount`,
because a run that was itself cancelled is not counted into any of the three
buckets. `@wfe/ui` handles this deliberately, not accidentally: the UI shows
the three counts and the total as separate, independently-labeled facts and
never derives or displays a "remaining" figure computed as `total - sum of
counts` — there is a test in the UI suite enforcing that no such derived
figure is rendered. If `computeProgress` later grows a `cancelled` bucket,
that test is the one to revisit.

### `PUT /api/v1/batch-jobs/{id}/cancel` returns 409 but the spec only declares 200/404

The route can return `409 BATCH_JOB_NOT_CANCELLABLE` at runtime (see
`packages/server/src/controllers/batch-jobs.ts`), but `buildOpenApiSpec`
declares only `200` and `404` responses for it. `@wfe/ui` still handles the
409 correctly, because it catches `ApiError` generically at the call site
rather than switching on declared status codes — but the generated client
gives no typed help for this case (no discriminated response type, no
autocompletion on the error shape). Worth adding `409` to the spec next time
`batch-jobs.ts`'s OpenAPI annotations are touched.

### `WorkflowRun.definitionSnapshot` is returned but undeclared in the schema

`GET /api/v1/runs/{id}` returns `definitionSnapshot` on the run (the
Phase 4 snapshot taken at run creation), but `buildOpenApiSpec` does not
declare that field on `WorkflowRun`. It therefore has no generated type and
`@wfe/ui` cannot reference it without an unsound cast. Nothing in Phase 5
needed it; flagged here so the next screen that wants to show "what
definition did this run actually execute against" knows the data exists on
the wire today but needs a schema fix first.

### `WorkflowRun.updatedDate` and `.stepRuns` are optional in the schema but required in practice

Both are declared optional in `buildOpenApiSpec`, but every run the server
actually returns has both populated, and `@wfe/ui` treats them as required.
This forces a documented, explained cast in three places: `useRuns.ts`,
`useDefinitions.ts`, and `useBatchJobs.ts` (search those files for the cast
comments). Declaring both fields required in the schema would remove all
three casts with no behavior change — a small, low-risk spec fix.

### The `/filter-configuration` date-range descriptor is dead on the UI side

`GET /api/v1/filter-configuration` describes a `dateRange` filter field, but
`FilterBar` (`packages/ui/src/components/FilterBar.tsx`) renders nothing for
it, because the underlying `GET /api/v1/runs` only ever accepts `status`,
`name`, `limit`, and `offset` — there is no server-side date filter for it to
drive. Two ways to close this, either is fine: give `GET /runs` a real date
filter and have `FilterBar` render the control, or remove the `dateRange`
descriptor from `/filter-configuration` so the endpoint stops advertising a
capability nothing implements.

### List screens have no pagination

The Run tracker, Definitions, and Batch jobs screens all call their list
endpoints with no `limit`/`offset`, so they get the server's default page
size (currently 50) and show no pager or "load more" control. Fine at the
data volumes exercised so far; will misbehave (silently truncate the list,
with no indication more rows exist) the first time a real deployment
accumulates more than one page of runs, definitions, or batch jobs. Worth a
pass in a follow-on phase — the server-side `limit`/`offset` parameters
already exist, so this is UI-only work.

### The drift test proves the client matches the OpenAPI document, not that the document matches the routes

`packages/ui/test/api/schema-freshness.test.ts` regenerates `openapi.json` and
`schema.d.ts` from the live `buildOpenApiSpec()` output and diffs them
byte-for-byte against what's committed. That is a real, valuable guarantee —
but it is a guarantee about internal consistency between the spec and the
generated client, not about whether the spec itself describes every route the
server actually serves. A route present in Express but missing (or
incompletely described) in `buildOpenApiSpec` is invisible to both the
generated client and this test — nothing fails, the UI simply cannot type
against that route. Phase 5 hit this directly: at one point 26 of the 29
declared operations had no declared response body at all, and a task
(Task 9 in the Phase 5 plan) had to be inserted specifically to add response
schemas for the twelve operations `@wfe/ui` actually consumes. There is no
current test that walks the Express route table and asserts every route has
a corresponding, fully-described `buildOpenApiSpec` entry — that would be the
right follow-on to close this gap for good.

### `schema-freshness.test.ts` leaks a temp directory per run

The test calls `mkdtempSync(join(tmpdir(), "wfe-api-"))` to get a scratch
directory to regenerate into, but never removes it (no `afterAll` /
`rmSync`). Every run of the `@wfe/ui` suite leaves one more `wfe-api-*`
directory in the OS temp dir. Harmless on a CI runner that gets torn down,
but on a long-lived dev machine or a local watch loop this accumulates
indefinitely. A two-line `afterAll(() => rmSync(tmp, { recursive: true,
force: true }))` fixes it.
