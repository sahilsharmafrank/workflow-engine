# Workflow Engine

A generic, JSON-defined workflow engine. Node, TypeScript, Postgres.

Workflows are JSON documents stored in the database. Each step declares where its
inputs come from using small expressions evaluated against the run's state. Every
piece of continuation state lives in Postgres, so a run created by one process can
be advanced by another — there is no in-memory run state to lose.

## Status

**Phase 1: engine core.** In-process step execution against Postgres, with a
sandboxed expression evaluator, a step registry, definition validation, and an
advance loop with at-least-once resume guards.

**Phase 2: queue drivers.** Pluggable queue drivers (in-memory, RabbitMQ, SQS)
behind a registry, delay and callback suspension with delay chaining past a
driver's own limit, and a `WorkflowWorker` that resumes runs from a queue. See
[Queues](#queues).

**Phase 3: REST API, CLI, Docker Compose.** An Express-based HTTP API over
definitions, runs and steps, an OpenAPI spec served at `/api/v1/docs`, a `wfe`
CLI (`migrate`, `import`, `serve`, `worker`), and a `Dockerfile` plus
`docker-compose.yml` `server`/`worker` services. See [REST API](#rest-api).

**Phase 4: plugins, steps, batch jobs.** Boot-time plugin loading from
`WFE_PLUGINS`, an expanded step library (`core.http`, `core.condition`,
`core.subWorkflow`, `core.emitEvent`), definition snapshotting onto the run at
creation, batch jobs that fan a definition out over many inputs, and a
`/filter-configuration` endpoint that drives UI filters from the registry.

Not built yet: the React UI. See [Roadmap](#roadmap).

## Requirements

| | |
|---|---|
| Node | `^24.0.0` (required — `isolated-vm` pins it) |
| npm | `>= 11` |
| Docker | Required for the tests and for a local Postgres |
| Postgres | 16 (any recent version should work) |

## Packages

| Package | Contents |
|---|---|
| `@wfe/sdk` | Dependency-free types, `WorkflowStatus`, `BaseStep`, `StepContext`. What step authors import. |
| `@wfe/core` | The engine: entities, migrations, expression evaluator, step registry, step library, plugin loader, validation, executor, queue drivers, worker. |
| `@wfe/server` | REST API (Express), OpenAPI spec, auth provider interface, and the `wfe` CLI. See [REST API](#rest-api). |

```
packages/sdk/src      types, status model, BaseStep, StepContext
packages/core/src
  config.ts           EngineConfig + loadEngineConfig
  errors.ts           WfeError
  expression/         isolate sandbox, capture + merge, run snapshot
  entities/           TypeORM entities (WorkflowRun, StepRun, definitions)
  db/                 DbContext + migrations
  repositories/       tenant-scoped data access
  registry/           step registry + definition validation
  steps/              built-in steps
  engine/             WorkflowManager (create) + RunExecutor (execute) + suspension planning
  queue/              QueueDriver contract, registry, memory/RabbitMQ/SQS drivers
  worker/             WorkflowWorker — consumes the delay and response queues
packages/server/src
  app.ts              createApp() — wires middleware + routers into an Express app
  config.ts           ServerConfig + loadServerConfig
  cli/                the `wfe` binary — migrate, import, serve, worker
  controllers/        route handlers: definitions, runs, steps, system
  middleware/         request id, tenant resolution, error handler
  auth/               AuthProvider interface + NoneAuthProvider
  openapi/            buildOpenApiSpec() served at /api/v1/docs
examples/             runnable examples + sample definitions
```

## Running locally

```bash
npm install
npm run build
```

Start Postgres:

```bash
docker run --rm -d --name wfe-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=wfe postgres:16-alpine
```

Run the example workflow:

```bash
export WFE_DB_URL=postgres://postgres:postgres@localhost:5432/wfe
npx tsc -p examples/tsconfig.json
node examples/run-example.js
```

Expected output — a completed run, with values that crossed between steps by name.
A pino log line (`"msg":"Created workflow run"`) is printed first; set
`WFE_LOG_LEVEL=silent` to suppress it.

```json
{
  "runId": 1,
  "status": "complete",
  "outputs": { "finalLabel": "checked", "attempts": 2 },
  "state": { "jobId": "job-42" },
  "steps": [
    { "n": 0, "name": "Prepare", "status": "complete" },
    { "n": 1, "name": "Check", "status": "complete" },
    { "n": 2, "name": "Finish", "status": "complete" }
  ]
}
```

The example applies the database migration itself on first run, so no separate
migration step is needed.

Run it **once per database**: it publishes the same definition every time, so a
second run against the same database fails with `duplicate key value violates
unique constraint "uq_workflow_definition"`. Recreate the container for a clean
slate.

Tear down when finished:

```bash
docker rm -f wfe-pg
```

## Tests

```bash
npm test                      # everything
npm test -w @wfe/core         # one package
npx turbo run test --force    # bypass the turbo cache
npm run typecheck
```

Integration tests start real Postgres containers via testcontainers, so **Docker
must be running**. Unit tests (evaluator, capture, registry, validation, SDK) need
no container.

## Configuration

Read by `loadEngineConfig()` from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `WFE_DB_URL` | *(required)* | Postgres connection string. Boot fails without it. |
| `WFE_SHOW_SQL` | `false` | Set `true` to log SQL. |
| `WFE_EXPRESSION_TIMEOUT_MS` | `100` | Per-expression wall-clock limit. Must be finite and positive — `0`, negatives and non-numbers are rejected at boot, because this is the only guard against a runaway expression. |
| `WFE_EXPRESSION_CONFIG_KEYS` | *(empty)* | Comma-separated allowlist filtering `expressionValues`. |
| `WFE_LOG_LEVEL` | `info` | pino level. Tests set `silent`. |

`expressionValues` — the map expressions can read via `config.*` — is set
**programmatically**, never from the environment:

```ts
const executor = new RunExecutor({
  config: { ...loadEngineConfig(), expressionValues: { region: "us-west-2" } },
  db, registry, evaluator,
});
```

This is deliberate. `EngineConfig` also holds `dbUrl`; sourcing expression scope
from a separate map makes the database credentials structurally unreachable from
user-authored expressions, rather than merely excluded by an allowlist someone
could misconfigure.

## Workflow definitions

A definition is JSON: a name, a version, a status, and an ordered list of steps.

```json
{
  "workflowName": "three-step",
  "workflowVersion": "1.0.0",
  "status": "published",
  "definition": {
    "steps": [
      {
        "stepName": "Prepare",
        "stepVersion": "1.0.0",
        "stepType": "core.transform",
        "stepInputs": [
          { "targetFieldName": "jobId", "modelEvaluationExpression": "workflowState.inputs.jobId" },
          { "targetFieldName": "attempt", "modelEvaluationExpression": "Number(1)" }
        ],
        "stepStateCapture": [
          { "targetFieldName": "jobId", "modelEvaluationExpression": "workflowState.stepStates.Prepare.outputs.jobId" }
        ]
      }
    ]
  }
}
```

| Field | Purpose |
|---|---|
| `stepType` | Registered step type. `stepClassName` is accepted as a legacy alias; `stepFileName` is accepted and ignored. |
| `stepInputs` | Resolved before the step runs, and handed to it as `ctx.inputs`. |
| `stepOutputs` | Captured after the step runs, merged into the **run's** outputs. |
| `stepStateCapture` | Captured after the step runs, merged into the **run's** state. |
| `preFlightCheck` | Conditions evaluated before the step. On failure: `continue`, `skip`, or `fail`. |

Step names must be unique — expressions address steps by name, and duplicates
would silently shadow each other.

### Capture expressions

Each expression is evaluated against three objects:

- `workflowState` — the run: `.inputs`, `.state`, `.outputs`, and `.stepStates.<StepName>`
- `config` — only the allowlisted `expressionValues` (see [Configuration](#configuration))
- `body` — the payload of a callback resuming this step, when there is one

```js
workflowState.inputs.jobId                          // read a run input
workflowState.stepStates.Prepare.outputs.attempt    // read another step's output by name
workflowState.stepStates.Prepare.outputs.attempt + 1
String("checked")                                   // literal
workflowState.state.jobId !== undefined             // a preflight condition
```

Expressions run inside an `isolated-vm` isolate with a wall-clock timeout and no
Node globals — no `require`, no `process`, no filesystem. The run state is JSON
round-tripped on the way in, which strips prototypes, getters and functions; a
consequence is that `Date` values arrive as ISO strings.

Treat definitions as trusted input regardless: the sandbox is a boundary, not a
licence to accept workflow JSON from anonymous users. There is no authentication
in this phase.

## Built-in steps

| Type | Behaviour |
|---|---|
| `core.noop` | Completes immediately, produces no outputs. |
| `core.transform` | Writes its resolved inputs straight to its outputs — moves and renames values with no code. |
| `core.delay` | Suspends the run for its `seconds` input, then completes. Rejects a non-finite or negative value with `DELAY_INVALID_SECONDS`. See [Queues](#queues). |
| `core.externalTask` | Dispatches to an external service's queue and waits for its callback. See [Queues](#queues). |
| `core.http` | Makes an HTTP request. Supports method, headers, body, a timeout, and retry with backoff. |
| `core.condition` | Evaluates a condition and either continues, skips the rest, or fails the run. |
| `core.subWorkflow` | Starts a child workflow run and, optionally, waits for it to finish. |
| `core.emitEvent` | Publishes a message to a named queue without suspending the run. |

## Writing a step

```ts
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

export class GreetStep extends BaseStep {
  /** Runs once, only on first entry — never on a resume. Good place to
   * dispatch a request whose reply the step will later wait for. */
  async start(ctx: StepContext): Promise<void> {
    ctx.logger.info("greeting", { name: ctx.inputs.name });
  }

  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (ctx.isResume) {
      // Re-entered after a suspension (a delay elapsing, or a callback
      // arriving as ctx.body). Nothing to resume here, so just complete.
      ctx.step.status = WorkflowStatus.COMPLETE;
      return { stepState: ctx.step };
    }
    ctx.step.outputs = { greeting: `hello ${ctx.inputs.name}` };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
```

Register it before starting the engine, then reference `"stepType": "demo.greet"`
from a definition:

```ts
registry.register({ type: "demo.greet", version: "1.0.0", factory: (p) => new GreetStep(p) });
```

`ctx` gives a step its resolved `inputs`, its own `step` row, the `run`, a
`logger`, the narrowed `config`, and `services` — the map of your own clients,
passed in when constructing the engine:

```ts
const executor = new RunExecutor({ config, db, registry, evaluator, services: { billing: billingClient } });
// inside a step: (ctx.services.billing as BillingClient).charge(...)
```

To suspend a step rather than complete it, return `suspend` instead of leaving
it unset. The run is marked `waiting` and the loop stops; a queue driver
publishes the message that resumes it. See [Queues](#queues).

## Plugins

Steps do not have to live in this repo. A plugin is any module with a callable
default export that takes the registry and registers step types on it.

```ts
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import type { StepRegistry } from "@wfe/core";

class EchoStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.outputs = { ...ctx.inputs };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

export default function register(registry: StepRegistry): void {
  registry.register({
    type: "sample.echo",
    version: "1.0.0",
    description: "Echoes its resolved inputs to outputs.",
    factory: (params) => new EchoStep(params),
  });
}
```

Point `WFE_PLUGINS` at it as a comma-separated list of module specifiers — an
npm package name or a path:

```bash
export WFE_PLUGINS=@acme/wfe-steps,./examples/sample-plugin
```

`wfe migrate`, `wfe serve` and `wfe worker` each load them at boot, after the
built-in steps are registered, so a plugin can override a built-in type by
registering the same name. A working example lives in
`examples/sample-plugin/`.

Loading is strict, because a half-registered registry fails later and further
from the cause than it needs to:

| Condition | Error |
|---|---|
| The module cannot be imported | `PLUGIN_LOAD_FAILED` |
| It has no callable default export | `PLUGIN_INVALID` |

A `register` function may be async; the loader awaits it before moving to the
next plugin.

## Queues

Phase 2 makes a step's suspension durable: instead of blocking a process, the
executor publishes a message to a queue and returns. Something consuming that
queue — usually a `WorkflowWorker` — resumes the run later, possibly from a
different process entirely.

### Suspension modes

A step chooses how it suspends by what it returns from `run()`. There is no
`suspend` field for "just complete" — that's the default when a step returns
without one, as `GreetStep` and every built-in step but `core.delay` and
`core.externalTask` do above. The two ways to actually suspend:

**`delay`** — sleep for a fixed period, then resume with no payload. This is
what `core.delay` does:

```ts
return { stepState: ctx.step, suspend: { kind: "delay", delaySeconds: 45 } };
```

**`awaitCallback`** — park until an external worker replies. Name the queue
the request went to (typically `ctx.step.externalServiceName`); `correlationId`
lets the reply be matched to this step. The named queue is one-way — the
engine only ever publishes a dispatch there, it never reads from it (see
[Running the worker](#running-the-worker)) — so the reply comes back on a
different channel: `RESPONSE_QUEUE` with `kind: "callback"`, or a direct call
to `executor.callback(...)`. This is what `core.externalTask` does:

```ts
return {
  stepState: ctx.step,
  suspend: {
    kind: "awaitCallback",
    queue: ctx.step.externalServiceName,
    correlationId: `${ctx.run.id}:${ctx.stepNumber}`,
  },
};
```

Either way, the step re-enters with `ctx.isResume === true` on resumption — a
delay resume carries no body, a callback resume carries the reply as
`ctx.body`.

### Selecting a driver

Drivers are registered in a global registry by name and constructed through
it, so the executor and worker never import a broker client directly:

```ts
import { createQueueDriver, listQueueDrivers } from "@wfe/core";

listQueueDrivers(); // ["memory"] until a broker driver is imported — see below

const queue = createQueueDriver(process.env.WFE_QUEUE_DRIVER ?? "memory", {
  url: process.env.WFE_QUEUE_URL,     // rabbitmq: required, e.g. amqp://localhost
  prefix: process.env.WFE_SQS_PREFIX, // sqs: physical queue name prefix, defaults to "wfe"
  region: process.env.AWS_REGION,     // sqs: also read directly by the SDK client if omitted here
});
```

`memory` (`MemoryQueueDriver`) is registered by importing `@wfe/core` itself —
it has no external dependency, so it's always available and is what the
in-process examples and tests use. `rabbitmq` and `sqs` are **not** exported
from `@wfe/core`'s barrel: importing either driver module pulls in `amqplib`
or the AWS SDK and registers the driver as a side effect, so a memory-only
deployment never has to carry either broker client. Import the one you want
explicitly, once, before calling `createQueueDriver`:

```ts
import "@wfe/core/dist/queue/rabbitmq-driver"; // registers "rabbitmq"
import "@wfe/core/dist/queue/sqs-driver";      // registers "sqs"
```

### Delay chaining

Every driver caps how long a single message can be delayed —
`MemoryQueueDriver` and `RabbitMqQueueDriver` at 900s, `SqsQueueDriver` at
SQS's own 900s native limit. A step can still ask for far longer (a 30-day
delay is `delaySeconds: 2_592_000`): the executor, not the driver, is
responsible for making that work. `planSuspension` (`engine/suspension.ts`)
splits the request into a first hop of at most `driver.maxDelaySeconds` and a
`remainingDelaySeconds` carried on the message; `RunExecutor.resume` sees the
remainder on the incoming message and republishes another hop instead of
running the step, until the remainder reaches zero and the step actually
resumes. A 30-day delay on a 900s-capped driver is therefore ~2,880 silent
hops of 900s each — invisible to the step, which only ever sees one
suspension and one resume.

### Running the worker

`WorkflowWorker` subscribes to exactly two queues — the delay queue
(`DELAY_QUEUE`) and the callback response queue (`RESPONSE_QUEUE`) — and
routes each message to `executor.resume` or `executor.callback`:

```ts
import { WorkflowWorker } from "@wfe/core";

const worker = new WorkflowWorker({ executor, queue });
await worker.start(); // ensures the delay and response queues exist, then subscribes to both
// ...
await worker.stop();
```

It runs as a long-lived process, separate from whatever creates and starts
runs — that separation is the point: one process can start a run and exit,
and the worker picks up every delay and callback for it whenever they arrive.

**`WorkflowWorker` never subscribes to a per-service queue
(`wfe-service-<name>`).** A `core.externalTask` step's suspension publishes
its dispatch *onto* `wfe-service-<name>` — that queue only ever carries
requests out to an external service, never replies back to the engine. If
`WorkflowWorker` also consumed that queue, it would compete with the real
external consumer for its own dispatch message, "resume" the step with no
body, and complete it with empty outputs before the external service ever
saw the request. This is why the two directions use different channels:

- **Outbound (engine → external service):** the engine publishes the
  dispatch to `wfe-service-<name>`. Something outside `WorkflowWorker` — your
  own consumer for that service — reads it, does the work, and replies.
- **Inbound (external service → engine):** the reply comes back either as a
  message on `RESPONSE_QUEUE` shaped `{ kind: "callback", tenantId, runId,
  stepNumber, body }` (which `WorkflowWorker` routes to
  `executor.callback(...)`), or via a direct call to
  `executor.callback(tenantId, runId, stepNumber, body)` — e.g. from an HTTP
  callback endpoint, which a future phase adds as `PUT /runs/:id/callback`.

`callback.test.ts` shows this end to end against a bare `MemoryQueueDriver`;
`external-task-worker.test.ts` shows it with a real `WorkflowWorker` also
running, and asserts the run stays `waiting` across a drain until the real
reply arrives.

### Local Postgres and RabbitMQ

`docker-compose.yml` brings up both:

```bash
docker compose up -d
docker compose down
```

Postgres is exposed on `5432` with the same credentials as the
[Running locally](#running-locally) section; RabbitMQ's AMQP port is `5672`
and its management UI is at `http://localhost:15672` (`guest`/`guest`). Port
`5432` is just as likely to already be taken here as it is for `docker run` —
see **Port 5432 already in use** under [Troubleshooting](#troubleshooting).

## Embedding the engine

`@wfe/core` is a library — no HTTP server required.

```ts
import "reflect-metadata";
import {
  DbContext, DefinitionRepository, ExpressionEvaluator, RunExecutor,
  StepRegistry, loadEngineConfig, registerBuiltInSteps, validateDefinitionShape,
} from "@wfe/core";
import { WorkflowDefinitionStatus } from "@wfe/sdk";

const config = loadEngineConfig();
const db = new DbContext(config);
await db.runMigrations();

const registry = new StepRegistry();
registerBuiltInSteps(registry);

const evaluator = new ExpressionEvaluator({ timeoutMs: config.expressionTimeoutMs });
const executor = new RunExecutor({ config, db, registry, evaluator });

const definition = await validateDefinitionShape(raw.definition);
await new DefinitionRepository(db).create({
  tenantId: "default", name: "three-step", version: "1.0.0",
  definition, status: WorkflowDefinitionStatus.PUBLISHED,
});

const runId = await executor.startWorkflow({
  tenantId: "default", name: "three-step", version: "1.0.0", inputs: { jobId: "job-42" },
});
const run = await executor.start("default", runId);

evaluator.dispose();
await db.close();
```

`startWorkflow` creates the run and its step rows but executes nothing;
`start`/`run` advance it. That separation is what lets one process create a run
and another execute it.

Other lifecycle calls: `executor.cancel(tenantId, runId)` and
`executor.restartFromStep(tenantId, runId, stepNumber)`, which resets that step
and every step after it before re-running.

## REST API

`@wfe/server` wraps the engine in an Express app (`createApp()`) and a CLI
(`wfe`) that boots it. Every application route lives under the base path
**`/api/v1`**; `/health` and `/version` are also mounted unprefixed for
load-balancer probes that don't know about the API version.

### Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | Liveness probe. Unauthenticated. |
| `GET` | `/api/v1/version` | Package version. Unauthenticated. |
| `GET` | `/api/v1/openapi.json` | Raw OpenAPI document. |
| `GET` | `/api/v1/docs` | Swagger UI over the same spec. |
| `GET`/`POST` | `/api/v1/definitions` | List / create workflow definitions. |
| `GET`/`PUT` | `/api/v1/definitions/:id` | Read / update a draft definition. |
| `POST` | `/api/v1/definitions/:id/publish` | Publish a draft. |
| `POST` | `/api/v1/definitions/import` | Bulk-import definitions (same shape as the CLI's `import`). |
| `POST` | `/api/v1/runs` | Start a new run. |
| `GET` | `/api/v1/runs` | List runs (filter by `status`, `name`; paginated). |
| `POST` | `/api/v1/runs/search` | Filter runs by jsonb-contained `inputs`/`outputs`/`state`. |
| `POST` | `/api/v1/runs/by-ids` | Batch-fetch runs by id. |
| `GET` | `/api/v1/runs/:id` | Read a run and its steps. |
| `PUT` | `/api/v1/runs/:id/cancel` | Cancel a run. |
| `PUT` | `/api/v1/runs/:id/restart/step/:n` | Restart from step `n`, resetting it and everything after it. |
| `PUT` | `/api/v1/runs/:id/callback` | Deliver an external callback to a suspended step (HTTP counterpart of `RESPONSE_QUEUE`). |
| `PUT` | `/api/v1/runs/:id/inputs` | Overwrite a run's captured inputs. |
| `GET` | `/api/v1/step-types` | List step types known to the registry. |
| `GET` | `/api/v1/steps/next` | Claim the next runnable step (polling consumers). |
| `POST` | `/api/v1/steps/search` | Filter step rows. |
| `PUT` | `/api/v1/steps/:id/state` | Overwrite a step's captured state. |
| `PUT` | `/api/v1/steps/:id/inputs-outputs` | Overwrite a step's inputs/outputs. |
| `PUT` | `/api/v1/steps/:id/priority` | Reprioritize a queued step. |
| `POST` | `/api/v1/steps/dry-run` | Evaluate a step's expressions without persisting anything. |
| `GET` | `/api/v1/filter-configuration` | Filter fields and their allowed values, derived from the registry. Drives UI filter controls. |
| `GET`/`POST` | `/api/v1/batch-jobs` | List / create batch jobs. |
| `GET` | `/api/v1/batch-jobs/:id` | Read a batch job and its progress. |
| `PUT` | `/api/v1/batch-jobs/:id/cancel` | Cancel a batch job. |

Every route below `/api/v1/docs` runs behind `tenantMiddleware`, which calls
the configured `AuthProvider` and stamps `tenantId`/`scopes` onto the
request — a null result is a 401. The only provider shipped so far is
`NoneAuthProvider` (accepts every request under tenant `"default"`); it is a
placeholder; a real provider is a follow-on Phase 3/4 concern once the API
has external callers, not a `WFE_AUTH_PROVIDER` value that already does
anything today.

### CLI

The `wfe` binary (`packages/server/dist/cli/index.js`, published as `bin.wfe`)
wraps the same building blocks the API and examples use:

```bash
wfe migrate            # run pending migrations, then exit
wfe import <dir>       # validate + publish every *.json definition in <dir>
wfe serve               # run migrations, then start the HTTP API (createApp())
wfe worker              # run migrations, then start WorkflowWorker (no HTTP)
```

`serve` and `worker` both call `db.runMigrations()` on boot, so a fresh
Postgres is ready to use without a separate migrate step in development;
`migrate` exists for pipelines that want that as an explicit, auditable step
ahead of a deploy.

### Configuration

`loadServerConfig()` reads everything `loadEngineConfig()` does (see
[Configuration](#configuration)) plus:

| Variable | Default | Meaning |
|---|---|---|
| `WFE_PORT` | `3000` | HTTP port for `wfe serve`. |
| `WFE_AUTH_PROVIDER` | `none` | Selects the `AuthProvider`. Only `none` (`NoneAuthProvider`) exists today. |
| `WFE_QUEUE_DRIVER` | `memory` | `memory`, `rabbitmq`, or `sqs` — passed to `createQueueDriver`. |
| `WFE_QUEUE_URL` | *(unset)* | Broker URL. Required for `rabbitmq`; ignored by `memory`. |
| `WFE_SQS_PREFIX` | *(unset)* | SQS physical queue name prefix. |
| `WFE_AWS_REGION` / `AWS_REGION` | *(unset)* | SQS region. |
| `WFE_SERVICES` | `{}` | JSON object of service client config, made available as `services` to steps. |
| `WFE_PLUGINS` | *(empty)* | Comma-separated module specifiers loaded at boot by `migrate`, `serve` and `worker`. See [Plugins](#plugins). |

### Quickstart with Docker Compose

`docker-compose.yml` now brings up Postgres, RabbitMQ, the API server, and a
worker together:

```bash
docker compose up -d --build
curl http://localhost:3000/api/v1/health
open http://localhost:3000/api/v1/docs   # Swagger UI
docker compose down
```

`server` and `worker` both build from the repo-root `Dockerfile` (Node 24
Alpine — `npm ci`, `npm run build`, then run the CLI); `worker` overrides the
image's default `CMD` (`wfe serve`) to run `wfe worker` instead. Both wait on
`postgres` and `rabbitmq`'s healthchecks before starting, and are wired to
the same credentials as [Local Postgres and RabbitMQ](#local-postgres-and-rabbitmq).

## Database

One squashed migration (`Init1788755800916`) creates three tables:

| Table | Holds |
|---|---|
| `workflow_definition` | Definitions, unique on `(tenant_id, name, version)` |
| `workflow_run` | Runs: status, current step, inputs/outputs/state as `jsonb` |
| `step_run` | Per-step rows: status, message, inputs/outputs/state, progress |

Apply with `await db.runMigrations()`. `synchronize` is off — the schema only ever
changes through migrations.

Every definition and run row carries a `tenant_id` (default `"default"`), and every
repository query filters on it.

## Resume guards

`RunExecutor.run` is built for at-least-once delivery, so duplicate and stale
invocations are expected. Three guards discard them rather than re-running work:

1. The run does not exist → error.
2. The run is `cancelled`, `cancelling`, `complete` or `paused` → discard.
3. `currentStep` does not match the requested step → discard. A never-started run
   (`currentStep = -1`) accepts step `0` only.

## Troubleshooting

**`npm install` fails with `E401` / auth errors.** This repo pins the public npm
registry in its own `.npmrc`, deliberately, so a machine-level private-registry
config cannot make the build depend on credentials other people do not have. If
you *want* a private registry, override it locally rather than deleting that file.

**`isolated-vm` fails to build.** It compiles native code and requires Node
`^24.0.0`. Check `node --version` before anything else.

**Tests hang or fail to start containers.** Testcontainers needs a running Docker
daemon — `docker info` should succeed.

**Port 5432 already in use.** Another Postgres is running. `docker run` fails with
`Bind for 0.0.0.0:5432 failed`, and — the confusing part — the example then
connects to the *other* server and usually dies with `password authentication
failed for user "postgres"`. Map a different host port and update `WFE_DB_URL`:

```bash
docker run --rm -d --name wfe-pg -p 5439:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=wfe postgres:16-alpine
export WFE_DB_URL=postgres://postgres:postgres@localhost:5439/wfe
```

**`duplicate key value violates unique constraint "uq_workflow_definition"`.** The
example was run twice against the same database. Recreate the container.

**`WFE_DB_URL is required`.** The variable is not exported in the shell running the
command.

## Roadmap

| Phase | Scope |
|---|---|
| 1 ✅ | Engine core — this repo |
| 2 ✅ | Queue drivers (SQS, RabbitMQ), delayed and callback-resumed steps — this repo |
| 3 ✅ | REST API, OpenAPI, CLI, Docker Compose — this repo |
| 4 ✅ | Plugin loading, built-in step library (http, condition, sub-workflow), batch jobs, filter-configuration endpoint, definition snapshotting — this repo |
| 5 | React UI — definitions, editor, run tracker |

Design and implementation notes live in `docs/superpowers/`. To pick this build
up on another machine, start with [`docs/handoff.md`](docs/handoff.md) — setup,
the verification rules, and what Phase 5 has to settle first. Deferred items
and their reasons are tracked in
[`docs/superpowers/carry-forward.md`](docs/superpowers/carry-forward.md).
