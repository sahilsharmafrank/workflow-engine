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

Not built yet: queue drivers (SQS/RabbitMQ), the REST API, plugin loading, and the
UI. See [Roadmap](#roadmap).

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
| `@wfe/core` | The engine: entities, migration, expression evaluator, step registry, validation, executor. |

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
  engine/             WorkflowManager (create) + RunExecutor (execute)
examples/             runnable example + sample definition
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

## Writing a step

```ts
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

export class GreetStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
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

To suspend a step rather than complete it, return `delaySeconds`. The run is
marked `waiting` and the loop stops; the queue driver that resumes it arrives in
Phase 2.

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
| 2 | Queue drivers (SQS, RabbitMQ), delayed and callback-resumed steps |
| 3 | REST API, OpenAPI, CLI, Docker Compose |
| 4 | Plugin loading, built-in step library (http, condition, sub-workflow) |
| 5 | React UI — definitions, editor, run tracker |

Design and implementation notes live in `docs/superpowers/`.
