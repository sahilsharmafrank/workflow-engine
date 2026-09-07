# Workflow Engine

A generic, JSON-defined workflow engine. Node, TypeScript, Postgres.

## Status

Phase 1: engine core. In-process step execution against Postgres. Queue drivers,
REST API, plugin loading and UI are not implemented yet.

## Packages

- `@wfe/sdk` — types and the `BaseStep` contract for step authors
- `@wfe/core` — the engine: entities, migrations, expression evaluator, step registry, executor

## Quickstart

```bash
npm install
npm run build

docker run --rm -d --name wfe-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=wfe postgres:16-alpine

export WFE_DB_URL=postgres://postgres:postgres@localhost:5432/wfe
npx tsc -p examples/tsconfig.json
node examples/run-example.js
```

Expected output: a completed run with `outputs` `{ "finalLabel": "checked", "attempts": 2 }`.

## Tests

```bash
npm test
```

Integration tests use testcontainers, so Docker must be running.

## Writing a step

```typescript
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

export class GreetStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.outputs = { greeting: `hello ${ctx.inputs.name}` };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
```

Register it before starting the engine:

```typescript
registry.register({ type: "demo.greet", version: "1.0.0", factory: (p) => new GreetStep(p) });
```

Then reference `"stepType": "demo.greet"` from a definition.
