# Phase 4: Plugin Loader, Built-in Steps, Definition Snapshotting, Batch Jobs — Design

Date: 2026-09-09
Status: Approved, pending implementation plan

## 1. Purpose

Phase 4 turns the engine from a framework into a product. Phases 1–3 built the
execution core, queue drivers, and REST API — but the only steps shipped are
`core.noop`, `core.transform`, `core.delay`, and `core.externalTask`. A user
cannot load their own step package, make an HTTP call from a step, fan out over
a record set, or safely edit a definition while runs are in flight.

This phase delivers:

- **Plugin loader** — `WFE_PLUGINS` specifiers are loaded at boot and registered.
- **Built-in step library** — `core.http`, `core.condition`, `core.subWorkflow`,
  `core.emitEvent`.
- **Definition snapshotting** — freeze the definition body onto the run at
  creation so edits don't affect in-flight runs.
- **Batch jobs** — fan out one definition over N input records with progress
  tracking.
- **Filter configuration endpoint** — `GET /filter-configuration` meta-endpoint
  for the future UI.
- **Carry-forward fixes** — delay-step NaN guard, CLI `parseAsync`, stale
  `handoff.md`.

Success criteria:

- A third-party step package loads via `WFE_PLUGINS` and its step type is
  runnable from the API.
- `core.http` makes a real HTTP request and captures the response.
- Editing a published definition and restarting a run uses the snapshotted
  definition, not the edited one.
- `POST /batch-jobs` fans out 10 runs and `GET /batch-jobs/:id` reports
  progress.
- `delay-step` rejects NaN input at step execution time.

## 2. Decisions

| Question | Decision |
|---|---|
| Plugin contract | Default export `(registry: StepRegistry) => void`. Sync or async — loader awaits either. |
| HTTP client for `core.http` | Node built-in `fetch` (no axios/got dependency). |
| `core.subWorkflow` wait semantics | MVP: `waitForCompletion: false` only. Child runs independently; caller gets `childRunId` in outputs. True waiting deferred — needs a completion hook on the child. |
| `StepContext` additions | `queue?: QueueDriver` for `core.emitEvent`; `startChildWorkflow?` callback for `core.subWorkflow`. |
| Definition snapshot storage | jsonb column on `workflow_run`. Nullable for backward compatibility with pre-snapshot runs. |
| Batch job execution model | Synchronous fan-out in the API handler. Async queue-driven fan-out is Phase 6 optimization. |
| Batch progress tracking | Computed on read via `WHERE id = ANY(runIds)` counts. No hooks in the executor. |

## 3. Plugin Loader

### 3.1 API

```ts
// packages/core/src/registry/plugin-loader.ts
export async function loadPlugins(
  specifiers: string[],
  registry: StepRegistry,
  logger?: Logger,
): Promise<void>;
```

For each specifier:
1. `await import(specifier)` — works for npm packages and relative paths.
2. Extract `mod.default ?? mod`.
3. If not a function, throw `WfeError` with code `PLUGIN_INVALID`.
4. Call `register(registry)` — if it returns a promise, await it.

### 3.2 Integration

Called in the CLI's `serve`, `worker`, and `import` commands after
`registerBuiltInSteps(registry)` and before any definition validation.

```ts
const registry = new StepRegistry();
registerBuiltInSteps(registry);
await loadPlugins(config.plugins, registry, log);
```

### 3.3 Example plugin

`examples/sample-plugin/` with:
- `package.json` (`name: "wfe-sample-plugin"`, `main: "index.js"`)
- `index.ts` — registers a `sample.echo` step that copies inputs to outputs.
- `tsconfig.json` extending the workspace base.

## 4. Built-in Step Library

### 4.1 StepContext additions

Two new optional fields on `StepContext` in `@wfe/sdk`:

```ts
queue?: {
  publish(queue: string, msg: unknown): Promise<void>;
};
startChildWorkflow?: (input: {
  name: string;
  version: string;
  inputs: WorkflowParameters;
}) => Promise<number>;
```

`queue` is typed as a narrow interface (not `QueueDriver`) so the SDK stays
dependency-free. The executor wires it to the real driver.

`startChildWorkflow` is a callback the executor provides, bound to the
current `tenantId`. It calls `WorkflowManager.startWorkflow` internally.

### 4.2 Steps

#### `core.http` — `packages/core/src/steps/http-step.ts`

| Input | Type | Default | Purpose |
|---|---|---|---|
| `url` | string | required | Request URL |
| `method` | string | `"GET"` | HTTP method |
| `headers` | object | `{}` | Request headers |
| `body` | unknown | `undefined` | Request body (JSON-serialized) |
| `retries` | number | `0` | Max retry attempts on failure/5xx |
| `backoffMs` | number | `1000` | Base backoff between retries (doubled each attempt) |
| `timeoutMs` | number | `30000` | Per-request timeout |

Outputs: `{ status, headers, body }`. Fails the step on non-2xx after
exhausting retries. Uses `AbortSignal.timeout()` for per-request timeout.

#### `core.condition` — `packages/core/src/steps/condition-step.ts`

| Input | Type | Purpose |
|---|---|---|
| `condition` | boolean | The evaluated condition (resolved by capture expressions) |
| `action` | `"skip"` \| `"fail"` | What to do when condition is falsy. Default: `"skip"`. |
| `message` | string? | Failure message when action is `"fail"` |

If `condition` is truthy, completes. If falsy and `action === "skip"`, marks
SKIPPED. If `action === "fail"`, throws `WfeError`.

#### `core.subWorkflow` — `packages/core/src/steps/sub-workflow-step.ts`

| Input | Type | Purpose |
|---|---|---|
| `name` | string | Child workflow definition name |
| `version` | string | Child workflow definition version |
| `inputs` | object | Inputs for the child run |

On `start()`: calls `ctx.startChildWorkflow({ name, version, inputs })` and
stores the child `runId` in step state and outputs. Completes immediately
(fire-and-forget). `waitForCompletion` deferred to a future phase.

#### `core.emitEvent` — `packages/core/src/steps/emit-event-step.ts`

| Input | Type | Purpose |
|---|---|---|
| `queue` | string | Target queue name |
| `payload` | object | Message payload |

Publishes `payload` to `queue` via `ctx.queue.publish()`. Completes
immediately. If `ctx.queue` is not available (no queue driver configured),
throws `WfeError` with code `QUEUE_NOT_CONFIGURED`.

### 4.3 Registration

All four added to `registerBuiltInSteps()` alongside the existing four.

## 5. Definition Snapshotting

### 5.1 Entity change

`WorkflowRun` gains:

```ts
@Column({ type: "jsonb", nullable: true })
definitionSnapshotJson?: unknown;

// Transient
definitionSnapshot?: WorkflowDefinitionBody;
```

Shuttled via `@BeforeInsert/@BeforeUpdate` and `@AfterLoad` like the other
jsonb columns.

### 5.2 Migration

`0004-definition-snapshot.ts` — `ALTER TABLE workflow_run ADD COLUMN
definition_snapshot jsonb`. Nullable — existing runs keep working via the
legacy lookup path.

### 5.3 startWorkflow change

After `lookupDefinition()`:

```ts
run.definitionSnapshot = definition.definition;
```

### 5.4 RunExecutor change

`definitionStepsFor(run)` prefers the snapshot:

```ts
protected async definitionStepsFor(run: WorkflowRun): Promise<StepDefinition[]> {
  if (run.definitionSnapshot) {
    return run.definitionSnapshot.steps;
  }
  const definition = await this.lookupDefinition({ ... });
  return definition.definition.steps;
}
```

## 6. Batch Jobs

### 6.1 Entity

`BatchJob` in `packages/core/src/entities/batch-job.ts`:

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `tenantId` | varchar(64) | default `"default"` |
| `name` | varchar(256) | human label |
| `definitionName` | varchar(256) | target workflow |
| `definitionVersion` | varchar(50) | target version |
| `status` | varchar(50) | `pending`, `running`, `complete`, `failed`, `cancelled` |
| `totalCount` | int | |
| `inputsJson` | jsonb | array of per-run input objects |
| `runIdsJson` | jsonb | array of created run IDs |
| `createdDate` | timestamptz | |
| `updatedDate` | timestamptz | |

### 6.2 Migration

`0005-batch-jobs.ts` — creates `batch_job` table.

### 6.3 Repository

`BatchJobRepository` with `create`, `findById`, `list(tenantId, filters)`,
`update`.

### 6.4 Controller

`packages/server/src/controllers/batch-jobs.ts`:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/batch-jobs` | Create + fan out |
| `GET` | `/api/v1/batch-jobs` | List (paginated, filterable by status) |
| `GET` | `/api/v1/batch-jobs/:id` | Detail with computed progress |
| `PUT` | `/api/v1/batch-jobs/:id/cancel` | Cancel all pending/running runs in the batch |

**Fan-out on create:** Iterates the `inputs` array, calls
`executor.startWorkflow()` + `executor.start()` for each, collects
`runIds`. Updates the batch record's `runIdsJson` and `status` to
`running`. On any error, records partial progress and sets `status` to
`failed` with the error in a `message` column.

**Progress on read:** `GET /batch-jobs/:id` computes `completedCount` and
`failedCount` by querying `workflow_run WHERE id = ANY(batch.runIds)
GROUP BY status`. No executor hooks needed.

### 6.5 OpenAPI

Add batch-job routes to the hand-maintained OpenAPI spec in
`packages/server/src/openapi/spec.ts`.

## 7. Filter Configuration Endpoint

`GET /api/v1/filter-configuration` — added to the system controller.

Returns:

```json
{
  "definitions": [
    { "field": "status", "type": "enum", "values": ["draft", "published", "archived"] },
    { "field": "name", "type": "text" }
  ],
  "runs": [
    { "field": "status", "type": "enum", "values": ["STARTING", "RUNNING", ...] },
    { "field": "name", "type": "text" },
    { "field": "createdDate", "type": "dateRange" }
  ],
  "steps": [
    { "field": "status", "type": "enum", "values": ["NEW", "RUNNING", ...] },
    { "field": "stepType", "type": "enum", "values": ["core.noop", ...] },
    { "field": "externalServiceName", "type": "text" }
  ]
}
```

`steps.stepType.values` populated from `registry.list()` at request time.

## 8. Carry-forward Fixes

### 8.1 Delay step NaN guard

In `delay-step.ts`, after computing `seconds`:

```ts
if (!Number.isFinite(seconds) || seconds < 0) {
  throw new WfeError(
    `delay seconds must be a non-negative number, got: ${ctx.inputs.seconds}`,
    { statusCode: 400, code: "DELAY_INVALID_SECONDS" },
  );
}
```

### 8.2 CLI parseAsync

Change `program.parse()` to `await program.parseAsync()` in
`packages/server/src/cli/index.ts`.

### 8.3 handoff.md update

Mark Phase 3 complete, update forward references to Phase 5.

### 8.4 carry-forward.md update

Mark delay NaN guard and parseAsync as resolved. Add any new deferred items.

## 9. Testing

| Feature | Test approach |
|---|---|
| Plugin loader | Unit test: mock plugin module, verify registration. Error test: non-function export. |
| `core.http` | Integration: start a local HTTP server in the test, run a workflow with an http step against it. |
| `core.condition` | Unit: truthy completes, falsy+skip → SKIPPED, falsy+fail → throws. |
| `core.subWorkflow` | Integration: testcontainer Postgres, start parent, verify child run created. |
| `core.emitEvent` | Integration: memory queue driver, verify message published. |
| Definition snapshot | Integration: create run, edit definition, restart-from-step, verify old definition used. |
| Batch jobs | Integration: create batch of 3, verify 3 runs created, GET returns correct progress. |
| Filter config | Unit: verify response shape, dynamic step types. |
| Delay NaN guard | Unit: NaN, negative, undefined inputs throw. |

## 10. Files Changed

### New files

| File | Package |
|---|---|
| `core/src/registry/plugin-loader.ts` | `@wfe/core` |
| `core/src/steps/http-step.ts` | `@wfe/core` |
| `core/src/steps/condition-step.ts` | `@wfe/core` |
| `core/src/steps/sub-workflow-step.ts` | `@wfe/core` |
| `core/src/steps/emit-event-step.ts` | `@wfe/core` |
| `core/src/entities/batch-job.ts` | `@wfe/core` |
| `core/src/repositories/batch-job-repository.ts` | `@wfe/core` |
| `core/db/migrations/0004-definition-snapshot.ts` | `@wfe/core` |
| `core/db/migrations/0005-batch-jobs.ts` | `@wfe/core` |
| `server/src/controllers/batch-jobs.ts` | `@wfe/server` |
| `examples/sample-plugin/package.json` | examples |
| `examples/sample-plugin/index.ts` | examples |

### Modified files

| File | Change |
|---|---|
| `sdk/src/step-context.ts` | Add `queue`, `startChildWorkflow` to `StepContext` |
| `core/src/entities/workflow-run.ts` | Add `definitionSnapshot` jsonb column + shuttle |
| `core/src/engine/workflow-manager.ts` | Snapshot definition onto run in `startWorkflow` |
| `core/src/engine/run-executor.ts` | Prefer snapshot in `definitionStepsFor`, wire new context fields |
| `core/src/registry/step-registry.ts` | Register 4 new steps in `registerBuiltInSteps` |
| `core/src/steps/delay-step.ts` | NaN guard |
| `core/src/index.ts` | Export new modules |
| `core/src/db/db-context.ts` | Register new entity + migrations |
| `server/src/cli/index.ts` | `parseAsync`, `loadPlugins` call |
| `server/src/controllers/system.ts` | Filter configuration endpoint |
| `server/src/app.ts` | Mount batch-jobs router |
| `server/src/openapi/spec.ts` | Batch-job routes |
| `docs/handoff.md` | Phase 3 → complete |
| `docs/superpowers/carry-forward.md` | Resolve delay NaN, parseAsync items |
| `README.md` | Phase 4 sections |

## 11. Out of Scope

Deferred deliberately:

- **`core.subWorkflow` with `waitForCompletion: true`.** Needs a run-completion
  hook to deliver a callback to the parent — a distinct feature.
- **Async batch fan-out.** Queue-driven fan-out for batches >100. Phase 6
  optimization.
- **Input schema validation at publish time.** `StepRegistration` has no
  `inputSchema` field yet. Adding JSON Schema validation of step inputs
  against a declared schema is Phase 5 (editor) or later.
- **Rate limiting.** Production hardening concern.
- **Kafka/Redis/NATS drivers.** Additive, not blocking.
- **RabbitMQ driver minors.** Ack/nack race, bucket clamping — same carry-forward.
