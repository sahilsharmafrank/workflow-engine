# Standalone Workflow Engine — Design

Date: 2026-09-07
Status: Approved, pending implementation plan

## 1. Purpose

Extract the workflow engine embedded in the Mastering Cloud monorepo
(`mc/packages/workflow`) into a standalone, domain-neutral product that anyone can
install and run. The engine's execution model — JSON-defined workflows, step-at-a-time
execution, all continuation state in Postgres, queue-driven resumption — is sound and
generic. What blocks reuse is packaging: the engine is welded to media-manufacturing
domain code and to a dozen private `@mast/*` packages.

Success criteria:

- `docker compose up` on a clean machine yields a running engine, API and UI with no
  AWS account and no private registry access.
- A developer can author a workflow definition in JSON, register custom steps from
  their own npm package, and run it — without forking the engine.
- No source file in the shipped product references media manufacturing, IMF, CPL,
  Genie, Baton, Wonderland, DeweyVision or the management portal.

Non-goals for v1: distributed transactions, visual drag-and-drop workflow canvas,
cron/schedule triggers, workflow versioning migration of in-flight runs, multi-region
deployment.

## 2. Decisions

| Question | Decision |
|---|---|
| Import strategy | Copy engine core only (~2,500 LOC). Do not vendor `@mast/*`. Do not copy `src/workflows/**`. |
| Queue layer | Pluggable driver registry. Ship `sqs` and `rabbitmq`. Postgres is the state store, not the queue. More drivers addable without touching core. |
| Step model | SDK package plus plugin loading into a step registry. Ship a built-in generic step library. |
| Expressions | Keep existing syntax for backward compatibility; evaluate in a sandbox instead of `new Function`. |
| UI | New Vite + React 18 + MUI app; port the screen logic out of the CRA portal app. |
| Auth | Deferred. `AuthProvider` seam exists with a single `none` implementation. |
| Tenancy | `tenantId` column present from day one, defaults to `"default"`. |
| Layout | npm workspaces monorepo, four packages. |

## 3. Architecture

### 3.1 Execution model

Carried over from the existing engine unchanged in substance. A run is a row plus N
step rows; every continuation state lives in Postgres jsonb. No in-memory run state
exists, so any server instance can advance any run, and instances scale horizontally.

```
POST /runs ──▶ WorkflowManager.startWorkflow()
                 persist WorkflowRun + N StepRun rows (status PENDING)
                 ▼
              run(runId, stepNumber)
                 ├─ preFlightCheckHook   conditions → CONTINUE | SKIP | FAIL
                 ├─ inputsCapture        expressions evaluated against
                 │                       { workflowState, config, body }
                 ├─ step.start() / step.run() → RunStepResponse { stepState, delaySeconds? }
                 ├─ outputsCapture / stateCapture merged back into run state
                 └─ next step
                      ├─ in-process step ─────▶ run(n+1) immediately
                      ├─ delaySeconds set ────▶ queue.publish(delay, { delaySeconds }) ─┐
                      └─ external step ───────▶ queue.publish(serviceQueue)             │
                                                   worker replies on response queue     │
                                                   or PUT /runs/:id/callback            │
                      ◀────────────────────────────────────────────────────────────────┘
                                        run() resumes at that step
```

Two long-lived subscriptions drive resumption: a **delay queue** and a
**worker-response queue**. `WorkflowWorker` subscribes to these two only.
Per-service request queues (`wfe-service-<name>`) are **outbound**: the engine
publishes to them when an external-task step dispatches work; external services
consume them independently and reply on the response queue or via
`PUT /runs/:id/callback`. The engine never reads from a service request queue.

(Amended in Phase 3 planning — Phase 2 resolved the contradiction between the
original lines 62–63 and 70–71 in favour of the data-flow diagram above. The
earlier text listing "per-service request queues" among the engine's
subscriptions was inherited from the original `remote-agent-response-listener`
description and was incorrect for this design.)

The original implementations are SQS-specific `while (true)` receive loops;
they collapse into one generic consumer driven by `QueueDriver.subscribe`.

Guards ported verbatim from `work-delay-listener`, because they are the correctness
core of at-least-once delivery: a resume message is discarded if the run no longer
exists, if `run.currentStep !== message.stepNumber`, or if the run is
`CANCELLED | CANCELLING | COMPLETE | PAUSED`.

### 3.2 Packages

npm workspaces plus turbo, matching the tooling already in use.

| Package | Contents | Depends on |
|---|---|---|
| `@wfe/sdk` | `BaseStep`, `StepContext`, run/step types, `WorkflowStatus`, definition types, `defineStep()` | none |
| `@wfe/core` | `WorkflowManager`, expression evaluator, TypeORM entities, migrations, repositories, step registry + plugin loader, queue driver registry, built-in steps | `@wfe/sdk` |
| `@wfe/server` | express app, REST controllers, `AuthProvider`, filter/search, OpenAPI, `wfe` CLI | `@wfe/core` |
| `@wfe/ui` | Vite + React 18 + MUI app | generated OpenAPI client |

Also at repo root: `docker-compose.yml` (postgres, rabbitmq, server, ui), `Dockerfile`,
`examples/` containing a sample third-party step plugin package and sample definitions.

`@wfe/core` must be usable as a library — embeddable in an existing Node app without
`@wfe/server`. That constraint is what keeps HTTP concerns out of core.

## 4. Porting map

### 4.1 Copied, adapted

| Source (`mc/packages/workflow/src/`) | Destination | Notes |
|---|---|---|
| `workflow-engine/workflow-manager.ts` (901) | `@wfe/core/manager` | Constructor's 16 positional domain-client params collapse to one `EngineOptions` object. Split into `manager.ts` (lifecycle) and `run-executor.ts` (step execution) — 900 lines in one file is past comfortable. |
| `workflow-engine/controller/workflow-controller.ts` (977) | `@wfe/server/controllers/runs.ts` + `definitions.ts` | Split by resource; it currently mixes run control, search and definition CRUD. |
| `workflow-engine/controller/steps-controller.ts` | `@wfe/server/controllers/steps.ts` | |
| `workflow-engine/controller/status-controller.ts` | `@wfe/server/controllers/system.ts` | |
| `workflow-engine/controller/workflow-definition.ts` | folded into `definitions.ts` | |
| `workflow-engine/model/entity/*.ts` | `@wfe/core/entities` | Renames in §5. jsonb shuttling via `@BeforeInsert`/`@AfterLoad` kept as-is. |
| `workflow-engine/model/repositories/*.ts` | `@wfe/core/repositories` | Add tenant scoping. |
| `workflow-engine/model/schema/*.ts` | `@wfe/core/schema` | yup schemas; drop the `PortalQueue` enum constraint on `externalServiceName`. |
| `workflow-engine/workflow-utils.ts` | `@wfe/core/expression` + `@wfe/core/query-filter` | `captureFromModelConfigAndBody` is the heart of the engine. Split the jsonb filter helpers out. |
| `workflow-engine/queues.ts`, the three listeners | `@wfe/core/queue` | Rewritten against `QueueDriver`. |
| `workflows/steps/BaseStep.ts` | `@wfe/sdk/base-step` | `extractLocalValues` returning 12 domain clients becomes `StepContext`. |
| `workflows/basic-workflow.ts` | `@wfe/core/workflow` | Already generic. |
| `workflow-engine/types/workflow-types.ts` | `@wfe/sdk/types` | |
| `lib/db-context.ts`, `lib/config.ts`, `lib/migration-utils.ts`, `lib/typeorm-cli-datasource.ts` | `@wfe/core/db`, `@wfe/server/config` | Config drops ~40 domain URLs and credentials. |
| `middleware/errors.ts`, `middleware/version-info.ts` | `@wfe/server/middleware` | |
| `cli/workflow-cli.ts` | `@wfe/server/cli` | |
| 8 schema migrations | one squashed `0001-init` | |
| `definitions/delay-example.json`, `make-string-example.json`, `minimal-*` | `examples/definitions` | Only the non-media ones. |

### 4.2 Rewritten — the `@mast` coupling

Ten import sites in engine core. Each has a small, obvious replacement:

| Dropped | Replaced by |
|---|---|
| `@mast/logging` (`mkLog`, `Extras`) | `pino` behind a `Logger` interface on `StepContext`; `Extras` becomes structured log fields |
| `@mast/common` — `createOrConfigureQueues`, `QueueRecord`, `RemoteAgentQueueManager` | `@wfe/core/queue` drivers |
| `@mast/common` — `makeApiAuthenticatorV2`, `makeAuthenticationMiddleware`, `routeAuthorizer`, `sanitizeStringFields` | `@wfe/server/auth` (`none` provider) + a local sanitizer |
| `@mast/management-portal-common` — `MCError` | `WfeError` with the same status/code shape |
| `@mast/management-portal-common` — `FilterConfigurations`, `FilterType`, `Filter` | `@wfe/core/query-filter`, same declarative filter descriptor idea, no portal vocabulary |
| `@mast/management-portal-common` — `PortalQueue`, `ServiceName`, `OUTBOUND_WORKFLOW_RESPONSE_QUEUE`, `GrantType` | config-driven `services: { name → queue }` routing map |
| `@mast/api-utils` — `getEntity`, `getEntityDetail`, `createEntity`, `updateEntity` | local generic CRUD helpers; the originals are already domain-neutral, reimplement thinly |
| `@mast/workflow-common` — all shared types | `@wfe/sdk/types` |
| `@mast/tools` — `ellipsize` | 4-line local util |
| `@mast/find` — `findFileUpSync` for `version.json` | build-time injected version constant |
| `dd-trace`, `lib/alerts.ts` + `lib/smtp-client.ts` | optional `Notifier` plugin interface; no telemetry vendor in core |
| `AppLocals` (bag of 8 domain API clients) | `StepContext` (§7.2) |

### 4.3 Dropped

- `src/workflows/**` — ~15,000 LOC of media steps and workflows (CPL build, IMF, timeline transform, histogram, SDR derive, Aspera, Genie, Baton, Wonderland).
- `src/aspera/**`.
- 66 of 74 migrations — workflow-definition data seeds for media workflows.
- 49 of 52 definition JSON files.
- `startSingleStepTestWorkflow`, `startMultiStepTestWorkflow`, `getRemoteAgentStepMeta` routes.

## 5. Data model

Postgres via TypeORM. Table renames drop the media-era vocabulary; column shapes are
otherwise preserved so the port stays mechanical.

| New table | Was | Key columns |
|---|---|---|
| `workflow_definition` | same | id, tenantId, name, version, status(`draft`\|`published`\|`archived`), definition jsonb, lastUpdateHistory jsonb, createdDate, updatedDate. Unique(tenantId, name, version) |
| `workflow_run` | `workflow_state` | id, tenantId, definitionId, name, version, currentStep, status, inputsJson, outputsJson, stateJson, createdDate, updatedDate |
| `step_run` | `step_state` | id, runId, stepNumber, stepName, stepType, status, message varchar(4000), inputsJson, stateJson, outputsJson, progress (embedded), externalServiceName, targetAgent, priority, remoteTaskStatus, lastStepAction timestamptz, originalRunId |
| `step_blob` | `workflow_step_blob` | Offload for oversized step payloads |
| `batch_job_record` | same | Already generic: batch fan-out over a record set |
| `idempotency_key` | new | tenantId, key, runId, createdDate — dedupes `POST /runs` |

Indexes: `workflow_run(tenantId, status, updatedDate)`, `workflow_run(tenantId, name, version)`,
`step_run(runId, stepNumber)`, `step_run(status, externalServiceName, priority)` for the
`GET /steps/next` claim path, GIN on `workflow_run.inputsJson` for jsonb search.

Preserved behaviours worth naming, because losing them silently would be a regression:

- `message` is ellipsized to 3,900 chars before persist so an over-length error cannot
  overflow the column and mask the real failure with a DB write error. Full detail stays
  in `outputsJson`.
- `stepStates` load eagerly and are sorted by `stepNumber` in `@AfterLoad`; expression
  evaluation depends on that ordering.
- Transient `inputs`/`outputs`/`state` fields shuttle to and from the jsonb columns on
  insert/update and load.

## 6. Expression evaluator

Definitions carry capture expressions such as `workflowState.inputs.orderId`,
`String("cplBuilt")`, `Number(0)`, `workflowState.stepStates.SomeStep.outputs.foo`.
Today these run through `new Function(...)` against a deep-cloned run state — arbitrary
JS from database rows, executed in-process with full Node scope.

The syntax is kept, so existing definitions and the editor UI keep working. The
execution changes:

- `isolated-vm` (or an equivalent isolate-based sandbox) with a hard wall-clock timeout
  per expression, default 100ms.
- Injected scope: `workflowState`, `config`, `body` only, deep-cloned and frozen.
- Whitelisted globals: `String`, `Number`, `Boolean`, `Date`, `Math`, `JSON`, `Array`,
  `Object`. No `require`, `process`, `fs`, `globalThis` reachability, no async.
- The `workflowState.stepStates.` → `workflowState.namedSteps.` rewrite is preserved, so
  steps stay addressable by both index and name.
- Result merge keeps lodash `set` + `mergeWith` with the existing `handleEmpty`
  customizer — an empty object on the right must not clobber a populated left.
- `config` exposure is narrowed to an explicit `expressionConfig` allowlist. Today the
  entire service config object, secrets included, is reachable from any expression.

Evaluation failures throw and fail the step, as today.

## 7. Steps

### 7.1 Registry and plugin loading

Definitions today name `stepFileName` and `stepClassName` as free text; the engine
`require`s that path out of its own bundle. Wrong names fail at runtime, mid-run.

Replacement: a step registry keyed by step type name.

```ts
registry.register({
  type: "http.request",
  version: "1.0.0",
  inputSchema,      // yup or JSON Schema — powers editor validation and /step-types
  outputSchema,
  factory: (params) => new HttpRequestStep(params),
});
```

Plugins load at boot from configured module specifiers (`WFE_PLUGINS=@acme/wfe-steps,./local-steps`).
A plugin is an npm package with a default export `(registry: StepRegistry) => void`.

Definition format v1 keeps the existing field names for compatibility and adds `stepType`
as the preferred alias for `stepClassName`. `stepFileName` is accepted and ignored.
Publishing a definition validates every `stepType` against the registry and every
`stepInputs` entry against the step's declared `inputSchema` — failures are rejected at
publish time rather than at run time.

Built-in step library shipped in `@wfe/core`:

| Type | Purpose |
|---|---|
| `core.http` | HTTP request with retry/backoff, response captured to outputs |
| `core.delay` | Sleep N seconds via the delay queue |
| `core.condition` | Branch — evaluate an expression, skip or jump |
| `core.transform` | Pure state reshape via capture expressions |
| `core.subWorkflow` | Start a child run, optionally wait for it |
| `core.emitEvent` | Publish a message to a configured queue/webhook |
| `core.externalTask` | Dispatch to a service queue and await callback |

### 7.2 StepContext

`BaseStep.extractLocalValues` currently returns twelve domain clients. Replacement:

```ts
interface StepContext {
  config: EngineConfig;          // narrowed, non-secret
  logger: Logger;
  db: DbContext;
  queue: QueueDriver;
  run: WorkflowRun;
  step: StepRun;
  stepNumber: number;
  services: Record<string, unknown>;  // user-registered, typed by the plugin author
  emitProgress(p: Progress): Promise<void>;
}
```

`services` is how a user injects their own API clients — registered once at engine
construction, retrieved by name in a step. That is the seam that made the original
engine unportable, and it is the single most important change in this design.

`BaseStep` keeps its shape: `preFlightCheckHook`, `start`, `run`, with `run` returning
`RunStepResponse { stepState, delaySeconds? }`. Preflight outcomes stay
`CONTINUE | SKIP | FAIL`.

## 8. Queue drivers

```ts
interface QueueDriver {
  ensureQueues(defs: QueueDefinition[]): Promise<void>;
  publish(queue: string, msg: WorkflowMessage, opts?: { delaySeconds?: number }): Promise<void>;
  subscribe(queue: string, handler: (msg: WorkflowMessage) => Promise<void>): Promise<Unsubscribe>;
  close(): Promise<void>;
}

registerQueueDriver("sqs", sqsFactory);
registerQueueDriver("rabbitmq", rabbitFactory);
```

- **sqs** — ports the existing code. Native `DelaySeconds`, capped at 900s. Long-poll
  receive, explicit delete after successful handling.
- **rabbitmq** — amqplib. Delay via a per-delay-bucket queue with message TTL plus a
  dead-letter exchange routing back to the work queue; uses the delayed-message-exchange
  plugin when the broker has it. Manual ack after successful handling.

Delays exceeding a driver's native limit are chained by core as repeated re-enqueues, so
drivers stay simple and a 30-day delay works everywhere.

Delivery is at-least-once on both drivers. Idempotency comes from the run-state guards
in §3.1, not from the broker.

Adding a driver later (Kafka, Redis, NATS, Postgres) means one file plus a
`registerQueueDriver` call — no core changes.

## 9. Auth and tenancy

Auth is deferred by decision. The seam ships anyway:

```ts
interface AuthProvider {
  authenticate(req): Promise<{ tenantId: string; scopes: string[] } | null>;
}
```

v1 ships one implementation, `none`, returning `{ tenantId: header("X-Tenant-Id") ?? "default", scopes: ["*"] }`.
Controllers and repositories are written against the resolved principal, so adding an
`apiKey` or `jwt` provider later is one new file and a config value.

**The API is unauthenticated in v1.** Anyone who can reach the port can create
definitions, and a definition contains expressions. The sandbox (§6) is the only
remaining boundary. Deployments must bind to localhost or sit behind an external
gateway until an auth provider lands.

Every definition and run row carries `tenantId`; every repository query filters on it.
Costs nothing now, avoids a migration across every table and query later.

## 10. REST API

All routes under `/api/v1`. OpenAPI 3 document served at `/openapi.json` and used to
generate the UI client.

**Definitions**

```
GET    /definitions                list + filter
POST   /definitions                create, yup-validated, step types checked against registry
GET    /definitions/:id
PUT    /definitions/:id            edit; previous version retained in lastUpdateHistory
POST   /definitions/:id/publish    draft → published → archived
POST   /definitions/import         bulk JSON import
```

**Runs**

```
POST   /runs                       { definition, version, inputs } → { runId }
GET    /runs                       list + filter
POST   /runs/search                deep jsonb filter
GET    /runs/:id                   run plus all step runs
POST   /runs/by-ids
PUT    /runs/:id/cancel
PUT    /runs/:id/restart/step/:n
PUT    /runs/:id/callback          external worker reply, resumes execution
PUT    /runs/:id/inputs
```

**Steps**

```
GET    /steps/next                 external worker claims next task
POST   /steps/search
PUT    /steps/:id/state
PUT    /steps/:id/inputs-outputs
PUT    /steps/:id/priority
GET    /step-types                 registry introspection with input/output schemas
POST   /steps/dry-run              evaluate one step's captures against a sample state,
                                   no persistence — powers the editor
```

**Batch jobs** — `GET|POST|PUT /batch-jobs`, `GET /batch-jobs/:id`.

**System** — `GET /health`, `GET /version`, `GET /filter-configuration`, `GET /openapi.json`.
Health and version are unlogged and unauthenticated, as today.

`POST /runs` accepts an `Idempotency-Key` header backed by the `idempotency_key` table.

## 11. UI

Vite, React 18, TypeScript, MUI 5, TanStack Query, client generated from OpenAPI via
`openapi-typescript`. No `@mast/ui-common`, no portal API client. React 17 + CRA are not
carried over; CRA is end-of-life and porting to it means migrating twice.

| Screen | Ported from | Content |
|---|---|---|
| Definitions | `ManageWorkflowDef`, `WorkflowDefinitionFileUpload`, `WorkflowDefDetailSlideModal` | Table, JSON upload, detail drawer, version history |
| Definition editor | `WorkflowStepsEditor` (491 LOC — the densest port) | Step list, per-step capture expressions, preflight config, registry-backed step-type picker, dry-run, publish |
| Run tracker | `WorkflowTrackerPage`, `WorkflowPill` | Filterable/sortable run table, status pills, jsonb search |
| Run detail | `WorkflowTaskPage`, `WorkflowTrackerSlideModal` | Step timeline, per-step inputs/outputs/message/progress, retry-from-step, cancel |
| Step catalog | new | Browse registry, schemas, originating plugin |

## 12. Configuration

Environment-driven, validated at boot, fail-fast on missing required values.

```
WFE_DB_URL=postgres://...            required
WFE_QUEUE_DRIVER=rabbitmq|sqs        default rabbitmq
WFE_QUEUE_URL=amqp://...             rabbitmq
WFE_AWS_REGION / WFE_SQS_PREFIX      sqs
WFE_PLUGINS=@acme/steps,./steps      comma-separated module specifiers
WFE_SERVICES={"billing":"billing-queue"}   external service → queue routing
WFE_AUTH_PROVIDER=none               default none
WFE_PORT=3000
WFE_LOG_LEVEL=info
WFE_EXPRESSION_TIMEOUT_MS=100
WFE_EXPRESSION_CONFIG_KEYS=a,b       allowlist reachable from expressions
```

CLI: `wfe migrate`, `wfe import <dir>`, `wfe serve`, `wfe worker` (listeners only, no HTTP).

## 13. Testing

- **Unit** — expression evaluator gets the hardest suite: sandbox escape attempts
  (`require`, `process`, constructor walking, prototype pollution, infinite loop against
  the timeout), plus a corpus of real capture expressions drawn from the existing
  definitions to prove syntax compatibility. Also merge semantics, preflight outcomes,
  state shuttling.
- **Integration** — testcontainers with real Postgres and RabbitMQ. Scenarios: in-process
  chain, delayed step round-trip, external-step dispatch and callback, cancel mid-run,
  restart-from-step, batch fan-out, duplicate resume message discarded by the currentStep
  guard, concurrent servers advancing distinct runs.
- **Contract** — golden fixtures from `delay-example.json`, `make-string-example.json`,
  `minimal-build-cpl.json` (stripped to generic steps).
- Existing `__tests__` covering engine internals are ported; media-workflow tests dropped.

Runner stays jest + ts-jest, matching the source project.

## 14. Build order

| Phase | Work | Milestone |
|---|---|---|
| 0 | Workspaces, turbo, tsconfig, eslint, docker-compose, CI | `npm run build` green |
| 1 | `@wfe/sdk` + `@wfe/core`: entities, manager, sandboxed evaluator, squashed init migration, in-process execution only | A node script runs a 3-step workflow against Postgres |
| 2 | Queue registry, `sqs` and `rabbitmq` drivers, delay and callback resumption | Delay workflow round-trips through RabbitMQ |
| 3 | `@wfe/server`: REST, OpenAPI, CLI | `docker compose up`, then curl starts a run |
| 4 | Plugin loader, built-in step library, example plugin package | A third-party step package loads and runs |
| 5 | `@wfe/ui`: five screens | Author a definition in the UI, run it, watch it in the tracker |
| 6 | Docs, examples, publish | Someone else can install it |

Phases 1–3 are the port. Phases 4–6 are new product surface.

## 15. Risks

- **`workflow-controller.ts` (977 LOC) and `workflow-manager.ts` (901 LOC)** carry
  undocumented behaviour accumulated over four years of production use. Splitting them
  during the port risks silent regressions. Mitigation: port first, split second, with
  integration tests written against the original behaviour before any restructuring.
- **`isolated-vm` is a native module.** It complicates Docker builds and Lambda-style
  deployment. Fallback if it proves painful: `vm` with a frozen context plus a worker
  thread for timeout enforcement — weaker isolation, documented as such.
- **RabbitMQ delay semantics** are not natively equivalent to SQS `DelaySeconds`. The
  TTL + dead-letter approach has known head-of-line blocking within a bucket queue; the
  bucketed design mitigates it but the integration test for long delays matters.
- **Expression backward compatibility** is asserted against the definition corpus, but
  that corpus is media-specific and will not ship. Keep it as a fixture in the test tree
  even though the definitions themselves are dropped.
