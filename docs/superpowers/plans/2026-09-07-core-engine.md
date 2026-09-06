# Workflow Engine Core — Implementation Plan (Phases 0–1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo and a working, domain-neutral workflow engine core that executes a JSON-defined multi-step workflow against Postgres, in-process, with a sandboxed expression evaluator.

**Architecture:** Two packages. `@wfe/sdk` holds dependency-free types and the `BaseStep` contract that step authors extend. `@wfe/core` holds the engine: TypeORM entities and migrations, a sandboxed expression evaluator, a step registry, and a `WorkflowManager`/`RunExecutor` pair that materializes a run from a definition and advances it step by step, persisting all continuation state to Postgres. No HTTP, no queue, no AWS in this plan — those arrive in Plan 2 and Plan 3.

**Tech Stack:** Node ^24, TypeScript 5.9 (CommonJS output), npm workspaces + turbo 2, TypeORM 0.3 + Postgres, `isolated-vm` for expression sandboxing, yup for definition validation, lodash for capture merging, pino for logging, jest + ts-jest, `@testcontainers/postgresql` for integration tests.

**Spec:** `docs/superpowers/specs/2026-09-07-standalone-workflow-engine-design.md`

## Global Constraints

- Node `^24.0.0`; npm `>=11`. TypeScript `^5.9.3`, `module: commonjs` (TypeORM decorators + `reflect-metadata` require it).
- **No `@mast/*` dependency may appear anywhere.** If a port needs one, reimplement it locally per spec §4.2.
- **No domain vocabulary in shipped code**: no media, IMF, CPL, order, Genie, Baton, Wonderland, DeweyVision, portal.
- Table names are snake_case via `typeorm-naming-strategies`' `SnakeNamingStrategy`; entity properties stay camelCase.
- Every definition and run row carries `tenantId`, `varchar(64) NOT NULL DEFAULT 'default'`. Every repository query filters on it.
- Expression evaluation goes through the sandbox — `new Function` and `eval` are banned in `@wfe/core` outside of tests that assert the ban.
- Expression timeout default: `100` ms. Step `message` column: `varchar(4000)`, ellipsized to `3900` chars before persist.
- Statuses come from the `WorkflowStatus` enum in `@wfe/sdk`. No string literals for status anywhere else.
- TDD: every task writes a failing test first, runs it to confirm the failure, then implements. Commit at the end of each task.

## File Structure

```
package.json                       root workspace, turbo scripts
turbo.json                         build/test/typecheck task graph
tsconfig.base.json                 shared compiler options
jest.config.base.js                shared ts-jest config
packages/sdk/
  src/index.ts                     public exports
  src/types.ts                     WorkflowParameters, definition + run shapes
  src/status.ts                    WorkflowStatus, outcome enums, status predicates
  src/logger.ts                    Logger interface
  src/step-context.ts              StepContext, RunStepResponse
  src/base-step.ts                 BaseStep abstract class
packages/core/
  src/index.ts                     public exports
  src/config.ts                    EngineConfig + loadEngineConfig
  src/logging.ts                   pino-backed Logger factory
  src/errors.ts                    WfeError
  src/expression/evaluator.ts      isolated-vm sandbox, single-expression eval
  src/expression/capture.ts        captureParameters — expression list → merged params
  src/expression/snapshot.ts       toPlainSnapshot — run state → sandbox-safe plain object
  src/entities/workflow-definition.ts
  src/entities/workflow-run.ts
  src/entities/step-run.ts
  src/entities/progress.ts
  src/db/naming.ts                 SnakeNamingStrategy wiring
  src/db/db-context.ts             DataSource lifecycle + runMigrations
  src/db/migrations/0001-init.ts
  src/repositories/definition-repository.ts
  src/repositories/run-repository.ts
  src/registry/step-registry.ts    register/resolve step types
  src/registry/validate.ts         yup schemas + registry cross-check
  src/steps/transform-step.ts      core.transform built-in
  src/steps/noop-step.ts           core.noop built-in
  src/engine/workflow-manager.ts   startWorkflow, cancel, restartFromStep, lifecycle
  src/engine/run-executor.ts       executeStep + run loop + resume guards
  test/…                           mirrors src/
examples/definitions/three-step.json
```

Rationale for the split: the source engine put lifecycle and step execution in one 901-line file. Here `workflow-manager.ts` owns run lifecycle (create, cancel, restart) and `run-executor.ts` owns advancing a run. They change for different reasons and are tested differently — the manager against the database, the executor against the registry.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `turbo.json`, `tsconfig.base.json`, `jest.config.base.js`, `.gitignore`
- Create: `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `packages/sdk/jest.config.js`, `packages/sdk/src/index.ts`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/jest.config.js`, `packages/core/src/index.ts`
- Test: `packages/sdk/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: workspace layout; `@wfe/sdk` and `@wfe/core` resolvable by name; `npm run build`, `npm test`, `npm run typecheck` at root.

- [ ] **Step 1: Write the failing test**

`packages/sdk/test/smoke.test.ts`:

```typescript
import { SDK_NAME } from "../src";

describe("sdk package", () => {
  it("exports its package name", () => {
    expect(SDK_NAME).toBe("@wfe/sdk");
  });
});
```

- [ ] **Step 2: Create the root workspace files**

`package.json`:

```json
{
  "name": "workflow-engine",
  "private": true,
  "version": "0.1.0",
  "engines": { "node": "^24.0.0", "npm": ">=11" },
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "clean": "turbo run clean"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "@types/node": "^24.0.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.4",
    "turbo": "^2.3.0",
    "typescript": "^5.9.3"
  }
}
```

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] },
    "clean": { "cache": false }
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "commonjs",
    "moduleResolution": "node",
    "declaration": true,
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`jest.config.base.js`:

```javascript
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/test/**/*.test.ts"],
  moduleNameMapper: {
    "^@wfe/sdk$": "<rootDir>/../sdk/src",
    "^@wfe/core$": "<rootDir>/../core/src"
  }
};
```

The `moduleNameMapper` points cross-package imports at source, so tests never depend on build order.

`.gitignore`:

```
node_modules/
dist/
coverage/
.turbo/
*.log
.env
```

- [ ] **Step 3: Create the two package skeletons**

`packages/sdk/package.json`:

```json
{
  "name": "@wfe/sdk",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest",
    "clean": "rm -rf dist coverage"
  }
}
```

`packages/sdk/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/sdk/jest.config.js`:

```javascript
module.exports = { ...require("../../jest.config.base.js"), rootDir: __dirname };
```

`packages/sdk/src/index.ts`:

```typescript
export const SDK_NAME = "@wfe/sdk";
```

`packages/core/package.json` — same shape, name `@wfe/core`, plus `"dependencies": { "@wfe/sdk": "0.1.0" }`. Copy `tsconfig.json` and `jest.config.js` from sdk verbatim. `packages/core/src/index.ts`:

```typescript
export const CORE_NAME = "@wfe/core";
```

- [ ] **Step 4: Install and run the test**

Run: `npm install && npm test`
Expected: PASS — one test in `@wfe/sdk`, `@wfe/core` reports no tests (add `--passWithNoTests` to core's test script).

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: `packages/sdk/dist/index.js` and `packages/core/dist/index.js` exist.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold npm workspaces monorepo with sdk and core packages"
```

---

### Task 2: SDK types and status model

**Files:**
- Create: `packages/sdk/src/types.ts`, `packages/sdk/src/status.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/status.test.ts`

**Interfaces:**
- Consumes: Task 1 scaffold.
- Produces: `WorkflowStatus`, `WorkflowDefinitionStatus`, `PreFlightCheckActionOutcome`, `isTerminalStatus(status)`, `isResumeBlocked(status)`, and the data shapes `WorkflowParameters`, `ParameterCaptureExpression`, `PreFlightCheckParameters`, `StepDefinition`, `WorkflowDefinitionBody`, `StepProgress`, `WorkflowRunLike`, `StepRunLike`. Every later task imports from here.

- [ ] **Step 1: Write the failing test**

`packages/sdk/test/status.test.ts`:

```typescript
import { WorkflowStatus, isTerminalStatus, isResumeBlocked } from "../src";

describe("status predicates", () => {
  it("treats complete, failed and cancelled as terminal", () => {
    expect(isTerminalStatus(WorkflowStatus.COMPLETE)).toBe(true);
    expect(isTerminalStatus(WorkflowStatus.FAILED)).toBe(true);
    expect(isTerminalStatus(WorkflowStatus.CANCELLED)).toBe(true);
  });

  it("does not treat running or waiting as terminal", () => {
    expect(isTerminalStatus(WorkflowStatus.RUNNING)).toBe(false);
    expect(isTerminalStatus(WorkflowStatus.WAITING)).toBe(false);
  });

  it("blocks resumption for cancelling and paused as well as terminal states", () => {
    expect(isResumeBlocked(WorkflowStatus.CANCELLING)).toBe(true);
    expect(isResumeBlocked(WorkflowStatus.PAUSED)).toBe(true);
    expect(isResumeBlocked(WorkflowStatus.CANCELLED)).toBe(true);
    expect(isResumeBlocked(WorkflowStatus.COMPLETE)).toBe(true);
    expect(isResumeBlocked(WorkflowStatus.RUNNING)).toBe(false);
  });
});
```

`isResumeBlocked` encodes the guard from the source engine's delay listener: a resume message for a run in one of these states is discarded, not executed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/sdk`
Expected: FAIL — `Cannot find module '../src'` export `WorkflowStatus`.

- [ ] **Step 3: Write the status model**

`packages/sdk/src/status.ts`:

```typescript
export enum WorkflowStatus {
  NEW = "new",
  STARTING = "starting",
  RUNNING = "running",
  WAITING = "waiting",
  COMPLETE = "complete",
  FAILED = "failed",
  CANCELLING = "cancelling",
  CANCELLED = "cancelled",
  PAUSED = "paused",
  SKIPPED = "skipped",
}

export enum WorkflowDefinitionStatus {
  DRAFT = "draft",
  PUBLISHED = "published",
  ARCHIVED = "archived",
}

export enum PreFlightCheckActionOutcome {
  CONTINUE = "continue",
  SKIP = "skip",
  FAIL = "fail",
}

const TERMINAL: ReadonlySet<WorkflowStatus> = new Set([
  WorkflowStatus.COMPLETE,
  WorkflowStatus.FAILED,
  WorkflowStatus.CANCELLED,
]);

const RESUME_BLOCKED: ReadonlySet<WorkflowStatus> = new Set([
  ...TERMINAL,
  WorkflowStatus.CANCELLING,
  WorkflowStatus.PAUSED,
]);

export function isTerminalStatus(status: WorkflowStatus): boolean {
  return TERMINAL.has(status);
}

export function isResumeBlocked(status: WorkflowStatus): boolean {
  return RESUME_BLOCKED.has(status);
}
```

- [ ] **Step 4: Write the data shapes**

`packages/sdk/src/types.ts`:

```typescript
import { PreFlightCheckActionOutcome, WorkflowStatus } from "./status";

export type WorkflowParameters = Record<string, unknown>;

export interface ParameterCaptureExpression {
  targetFieldName: string;
  modelEvaluationExpression: string;
}

export interface PreFlightCheckParameters {
  conditionsToCheck: ParameterCaptureExpression[];
  actionOnFailure: PreFlightCheckActionOutcome;
  failureMessage?: string;
}

/**
 * One step inside a workflow definition document.
 * `stepClassName` and `stepFileName` are accepted for backward compatibility with
 * definitions authored against the original engine. `stepFileName` is ignored;
 * `stepClassName` is treated as an alias for `stepType` when `stepType` is absent.
 */
export interface StepDefinition {
  stepName: string;
  stepVersion: string;
  stepType?: string;
  stepClassName?: string;
  stepFileName?: string;
  stepInputs: ParameterCaptureExpression[];
  stepOutputs?: ParameterCaptureExpression[];
  stepStateCapture?: ParameterCaptureExpression[];
  externalServiceName?: string;
  preFlightCheck?: PreFlightCheckParameters;
}

export interface WorkflowDefinitionBody {
  steps: StepDefinition[];
}

export interface StepProgress {
  units?: string;
  totalExpected?: number;
  currentProgress?: number;
}

/** Plain shape of a persisted run. Core entities implement this. */
export interface WorkflowRunLike {
  id?: number;
  tenantId: string;
  definitionId?: number;
  name: string;
  version: string;
  currentStep: number;
  status: WorkflowStatus;
  inputs: WorkflowParameters;
  outputs: WorkflowParameters;
  state: WorkflowParameters;
  stepRuns?: StepRunLike[];
}

/** Plain shape of a persisted step. Core entities implement this. */
export interface StepRunLike {
  id?: number;
  stepNumber: number;
  stepName: string;
  stepType: string;
  status: WorkflowStatus;
  message?: string;
  inputs: WorkflowParameters;
  outputs: WorkflowParameters;
  state: WorkflowParameters;
  progress?: StepProgress;
  externalServiceName?: string;
  lastStepAction?: Date;
}

/** Resolves the effective step type, honouring the legacy alias. */
export function resolveStepType(step: StepDefinition): string {
  const type = step.stepType ?? step.stepClassName;
  if (!type) {
    throw new Error(`Step "${step.stepName}" declares neither stepType nor stepClassName`);
  }
  return type;
}
```

- [ ] **Step 5: Export from the index**

`packages/sdk/src/index.ts`:

```typescript
export const SDK_NAME = "@wfe/sdk";
export * from "./status";
export * from "./types";
```

- [ ] **Step 6: Run tests**

Run: `npm test -w @wfe/sdk`
Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): add workflow status model and definition/run type shapes"
```

---

### Task 3: BaseStep and StepContext

**Files:**
- Create: `packages/sdk/src/logger.ts`, `packages/sdk/src/step-context.ts`, `packages/sdk/src/base-step.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/base-step.test.ts`

**Interfaces:**
- Consumes: `WorkflowParameters`, `WorkflowRunLike`, `StepRunLike`, `WorkflowStatus` from Task 2.
- Produces: `Logger`, `StepContext`, `RunStepResponse`, `StepParams`, `BaseStep` (abstract, `run(ctx): Promise<RunStepResponse>`, overridable `onBeforeRun(ctx): Promise<void>`), and `StepFactory = (params: StepParams) => BaseStep`. Task 8's registry stores `StepFactory`; Task 11's executor calls `onBeforeRun` then `run`.

- [ ] **Step 1: Write the failing test**

`packages/sdk/test/base-step.test.ts`:

```typescript
import {
  BaseStep,
  RunStepResponse,
  StepContext,
  StepParams,
  WorkflowStatus,
} from "../src";

class EchoStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.outputs = { echoed: ctx.inputs.message };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

function makeContext(inputs: Record<string, unknown>): StepContext {
  return {
    config: {},
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    services: {},
    inputs,
    stepNumber: 0,
    run: {
      tenantId: "default",
      name: "t",
      version: "1.0.0",
      currentStep: 0,
      status: WorkflowStatus.RUNNING,
      inputs: {},
      outputs: {},
      state: {},
    },
    step: {
      stepNumber: 0,
      stepName: "Echo",
      stepType: "test.echo",
      status: WorkflowStatus.RUNNING,
      inputs: {},
      outputs: {},
      state: {},
    },
  };
}

describe("BaseStep", () => {
  const params: StepParams = { name: "Echo", version: "1.0.0", type: "test.echo" };

  it("exposes its declared identity", () => {
    const step = new EchoStep(params);
    expect(step.name).toBe("Echo");
    expect(step.type).toBe("test.echo");
    expect(step.version).toBe("1.0.0");
  });

  it("runs and writes outputs onto the step state", async () => {
    const ctx = makeContext({ message: "hello" });
    const response = await new EchoStep(params).run(ctx);
    expect(response.stepState.outputs).toEqual({ echoed: "hello" });
    expect(response.delaySeconds).toBeUndefined();
  });

  it("provides a no-op onBeforeRun hook by default", async () => {
    const ctx = makeContext({});
    await expect(new EchoStep(params).onBeforeRun(ctx)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/sdk -- base-step`
Expected: FAIL — `BaseStep` is not exported.

- [ ] **Step 3: Write the logger and context**

`packages/sdk/src/logger.ts`:

```typescript
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
```

`packages/sdk/src/step-context.ts`:

```typescript
import { Logger } from "./logger";
import { StepRunLike, WorkflowParameters, WorkflowRunLike } from "./types";

/**
 * Everything a step is allowed to see. `services` is the injection seam that
 * replaces the original engine's bag of domain API clients: callers register
 * their own clients when constructing the engine, steps retrieve them by name.
 */
export interface StepContext {
  config: Readonly<Record<string, unknown>>;
  logger: Logger;
  services: Readonly<Record<string, unknown>>;
  run: WorkflowRunLike;
  step: StepRunLike;
  stepNumber: number;
  /** Inputs already resolved from the step's capture expressions. */
  inputs: WorkflowParameters;
  /** Payload supplied by an external callback resuming this step, if any. */
  body?: unknown;
}

export interface RunStepResponse {
  stepState: StepRunLike;
  /** When set, the executor suspends the run and resumes this step later. */
  delaySeconds?: number;
}
```

- [ ] **Step 4: Write BaseStep**

`packages/sdk/src/base-step.ts`:

```typescript
import { RunStepResponse, StepContext } from "./step-context";

export interface StepParams {
  name: string;
  version: string;
  type: string;
}

export abstract class BaseStep {
  readonly name: string;
  readonly version: string;
  readonly type: string;

  constructor(params: StepParams) {
    this.name = params.name;
    this.version = params.version;
    this.type = params.type;
  }

  /**
   * Optional hook run after the declarative pre-flight check passes and before
   * `run`. Override for step-specific setup; the default does nothing.
   */
  async onBeforeRun(_ctx: StepContext): Promise<void> {
    return;
  }

  abstract run(ctx: StepContext): Promise<RunStepResponse>;
}

export type StepFactory = (params: StepParams) => BaseStep;
```

- [ ] **Step 5: Export and run tests**

Add to `packages/sdk/src/index.ts`:

```typescript
export * from "./logger";
export * from "./step-context";
export * from "./base-step";
```

Run: `npm test -w @wfe/sdk`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): add BaseStep contract and StepContext injection seam"
```

---

### Task 4: Sandboxed expression evaluator

**Files:**
- Create: `packages/core/src/errors.ts`, `packages/core/src/expression/snapshot.ts`, `packages/core/src/expression/evaluator.ts`
- Modify: `packages/core/package.json` (add `isolated-vm`)
- Test: `packages/core/test/expression/evaluator.test.ts`

**Interfaces:**
- Consumes: `WorkflowRunLike` from `@wfe/sdk`.
- Produces: `WfeError`, `toPlainSnapshot(run): PlainRun`, and `class ExpressionEvaluator { constructor(opts: { timeoutMs?: number }); evaluate(expression: string, scope: EvaluationScope): Promise<unknown>; dispose(): void }` where `EvaluationScope = { workflowState: unknown; config?: unknown; body?: unknown }`. Task 5 wraps this; Tasks 9 and 11 consume it.

**Design notes for the implementer:**

The original engine evaluated capture expressions with `new Function("workflowState", "config", "body", "return " + expr)` — arbitrary JavaScript from a database row, running in the server's own scope. This task replaces the execution mechanism while preserving the syntax exactly, so existing definitions keep working.

Two behaviours must be preserved verbatim from `workflow-utils.ts`:

1. The string `workflowState.stepStates.` is rewritten to `workflowState.namedSteps.` before evaluation, so steps are addressable by name as well as index.
2. `namedSteps` is built by reducing the step list into a name-keyed map.

One behaviour deliberately changes: the scope is JSON round-tripped before entering the sandbox, so `Date` values arrive as ISO strings. Assert this in a test rather than leaving it to be discovered.

- [ ] **Step 1: Write the failing test**

`packages/core/test/expression/evaluator.test.ts`:

```typescript
import { ExpressionEvaluator } from "../../src/expression/evaluator";

describe("ExpressionEvaluator", () => {
  let evaluator: ExpressionEvaluator;

  beforeAll(() => {
    evaluator = new ExpressionEvaluator({ timeoutMs: 100 });
  });

  afterAll(() => evaluator.dispose());

  const scope = {
    workflowState: {
      inputs: { jobId: "abc-123", count: 2 },
      namedSteps: { Fetch: { outputs: { size: 10 } } },
    },
    config: { region: "us-west-2" },
    body: { callbackValue: 7 },
  };

  it("reads a value out of workflow inputs", async () => {
    await expect(evaluator.evaluate("workflowState.inputs.jobId", scope)).resolves.toBe("abc-123");
  });

  it("supports literal constructors used by existing definitions", async () => {
    await expect(evaluator.evaluate('String("published")', scope)).resolves.toBe("published");
    await expect(evaluator.evaluate("Number(0)", scope)).resolves.toBe(0);
  });

  it("supports arithmetic and Math", async () => {
    await expect(evaluator.evaluate("Math.max(workflowState.inputs.count, 5)", scope)).resolves.toBe(5);
  });

  it("reads config and callback body", async () => {
    await expect(evaluator.evaluate("config.region", scope)).resolves.toBe("us-west-2");
    await expect(evaluator.evaluate("body.callbackValue", scope)).resolves.toBe(7);
  });

  it("rewrites stepStates access to namedSteps", async () => {
    await expect(
      evaluator.evaluate("workflowState.stepStates.Fetch.outputs.size", scope)
    ).resolves.toBe(10);
  });

  it("returns objects and arrays by value", async () => {
    await expect(evaluator.evaluate("workflowState.inputs", scope)).resolves.toEqual({
      jobId: "abc-123",
      count: 2,
    });
  });

  describe("sandbox isolation", () => {
    it("has no require", async () => {
      await expect(evaluator.evaluate('require("fs")', scope)).rejects.toThrow();
    });

    it("has no process", async () => {
      await expect(evaluator.evaluate("process.env", scope)).rejects.toThrow();
    });

    it("cannot reach the host through constructor walking", async () => {
      await expect(
        evaluator.evaluate('(function(){}).constructor("return process")()', scope)
      ).rejects.toThrow();
    });

    it("cannot pollute the host prototype chain", async () => {
      await evaluator
        .evaluate('(Object.prototype.polluted = "yes", 1)', scope)
        .catch(() => undefined);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("aborts an infinite loop at the timeout", async () => {
      await expect(evaluator.evaluate("while (true) {}", scope)).rejects.toThrow();
    }, 10000);
  });

  it("throws a WfeError naming the failing expression", async () => {
    await expect(evaluator.evaluate("workflowState.missing.deep", scope)).rejects.toThrow(
      /workflowState\.missing\.deep/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- evaluator`
Expected: FAIL — `Cannot find module '../../src/expression/evaluator'`.

- [ ] **Step 3: Add the dependency**

```bash
npm install isolated-vm --workspace @wfe/core
```

- [ ] **Step 4: Write WfeError**

`packages/core/src/errors.ts`:

```typescript
export class WfeError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, opts: { statusCode?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = "WfeError";
    this.statusCode = opts.statusCode ?? 500;
    this.code = opts.code ?? "WFE_ERROR";
    this.details = opts.details;
  }
}
```

- [ ] **Step 5: Write the snapshot helper**

`packages/core/src/expression/snapshot.ts`:

```typescript
import { StepRunLike, WorkflowRunLike } from "@wfe/sdk";

export interface PlainRun {
  [key: string]: unknown;
  namedSteps: Record<string, unknown>;
}

/**
 * Produces a plain, structured-clonable snapshot of a run for the sandbox, with
 * `namedSteps` added so expressions can address steps by name.
 *
 * The JSON round-trip is deliberate: it strips entity prototypes, getters and
 * functions so nothing from the host can leak into the isolate. Dates become ISO
 * strings as a consequence.
 */
export function toPlainSnapshot(run: WorkflowRunLike): PlainRun {
  const plain = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
  const namedSteps: Record<string, unknown> = {};
  const steps: StepRunLike[] = (plain.stepRuns as StepRunLike[]) ?? [];
  for (const step of steps) {
    if (step.stepName) {
      namedSteps[step.stepName] = step;
    }
  }
  return { ...plain, stepStates: steps, namedSteps };
}
```

- [ ] **Step 6: Write the evaluator**

`packages/core/src/expression/evaluator.ts`:

```typescript
import ivm from "isolated-vm";
import { WfeError } from "../errors";

export interface EvaluationScope {
  workflowState: unknown;
  config?: unknown;
  body?: unknown;
}

export interface EvaluatorOptions {
  timeoutMs?: number;
  memoryLimitMb?: number;
}

const DEFAULT_TIMEOUT_MS = 100;
const DEFAULT_MEMORY_MB = 32;

/**
 * Evaluates workflow capture expressions inside an isolate. The isolate has no
 * Node globals at all — no require, no process, no filesystem — so the only
 * reachable data is what this class copies in.
 */
export class ExpressionEvaluator {
  private readonly isolate: ivm.Isolate;
  private readonly timeoutMs: number;

  constructor(options: EvaluatorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.isolate = new ivm.Isolate({ memoryLimit: options.memoryLimitMb ?? DEFAULT_MEMORY_MB });
  }

  /** Preserves the original engine's step-name addressing rewrite. */
  private static rewrite(expression: string): string {
    return expression.replace(/workflowState\.stepStates\./g, "workflowState.namedSteps.");
  }

  async evaluate(expression: string, scope: EvaluationScope): Promise<unknown> {
    const context = await this.isolate.createContext();
    try {
      const jail = context.global;
      await jail.set("__workflowState", new ivm.ExternalCopy(scope.workflowState ?? {}).copyInto());
      await jail.set("__config", new ivm.ExternalCopy(scope.config ?? {}).copyInto());
      await jail.set("__body", new ivm.ExternalCopy(scope.body ?? undefined).copyInto());

      const source = `(function (workflowState, config, body) { return (${ExpressionEvaluator.rewrite(
        expression
      )}); })(__workflowState, __config, __body)`;

      const script = await this.isolate.compileScript(source);
      return await script.run(context, { timeout: this.timeoutMs, copy: true });
    } catch (err) {
      throw new WfeError(
        `Failed evaluating expression "${expression}": ${(err as Error).message}`,
        { statusCode: 400, code: "EXPRESSION_EVALUATION_FAILED", details: { expression } }
      );
    } finally {
      context.release();
    }
  }

  dispose(): void {
    this.isolate.dispose();
  }
}
```

- [ ] **Step 7: Run tests**

Run: `npm test -w @wfe/core -- evaluator`
Expected: PASS — 13 tests, including all five isolation tests.

If `isolated-vm` fails to build on this machine, stop and report it rather than falling back silently — spec §15 names the fallback (`vm` plus a worker thread) as a decision that needs to be made explicitly.

- [ ] **Step 8: Commit**

```bash
git add packages/core
git commit -m "feat(core): add isolate-backed expression evaluator replacing new Function"
```

---

### Task 5: Capture and merge

**Files:**
- Create: `packages/core/src/expression/capture.ts`
- Modify: `packages/core/package.json` (add `lodash`, `@types/lodash`)
- Test: `packages/core/test/expression/capture.test.ts`

**Interfaces:**
- Consumes: `ExpressionEvaluator` (Task 4), `toPlainSnapshot` (Task 4), `ParameterCaptureExpression` and `WorkflowParameters` (Task 2).
- Produces: `captureParameters(opts: { evaluator, run, expressions, config?, body? }): Promise<WorkflowParameters>`. Tasks 9 and 11 call it for step inputs, outputs, state and pre-flight conditions.

**Design note:** this is the port of `captureFromModelConfigAndBody`. The merge semantics matter and are easy to lose: each expression produces a nested object via lodash `set` on its dotted `targetFieldName`, then all of them merge with `mergeWith` under a customizer that refuses to let an *empty* object on the right clobber a populated value on the left.

- [ ] **Step 1: Write the failing test**

`packages/core/test/expression/capture.test.ts`:

```typescript
import { WorkflowStatus } from "@wfe/sdk";
import { captureParameters } from "../../src/expression/capture";
import { ExpressionEvaluator } from "../../src/expression/evaluator";

const run = {
  tenantId: "default",
  name: "test",
  version: "1.0.0",
  currentStep: 1,
  status: WorkflowStatus.RUNNING,
  inputs: { jobId: "j-1", retries: 3 },
  outputs: {},
  state: { region: "eu" },
  stepRuns: [
    {
      stepNumber: 0,
      stepName: "Fetch",
      stepType: "core.noop",
      status: WorkflowStatus.COMPLETE,
      inputs: {},
      outputs: { size: 42 },
      state: {},
    },
  ],
};

describe("captureParameters", () => {
  let evaluator: ExpressionEvaluator;
  beforeAll(() => (evaluator = new ExpressionEvaluator({ timeoutMs: 200 })));
  afterAll(() => evaluator.dispose());

  it("maps each expression onto its target field", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "jobId", modelEvaluationExpression: "workflowState.inputs.jobId" },
        { targetFieldName: "label", modelEvaluationExpression: 'String("ready")' },
      ],
    });
    expect(params).toEqual({ jobId: "j-1", label: "ready" });
  });

  it("expands dotted target field names into nested objects", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "opts.retries", modelEvaluationExpression: "workflowState.inputs.retries" },
        { targetFieldName: "opts.region", modelEvaluationExpression: "workflowState.state.region" },
      ],
    });
    expect(params).toEqual({ opts: { retries: 3, region: "eu" } });
  });

  it("resolves prior step outputs by step name", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "size", modelEvaluationExpression: "workflowState.stepStates.Fetch.outputs.size" },
      ],
    });
    expect(params).toEqual({ size: 42 });
  });

  it("does not let an empty object clobber a populated value", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "opts", modelEvaluationExpression: "({ a: 1 })" },
        { targetFieldName: "opts", modelEvaluationExpression: "({})" },
      ],
    });
    expect(params).toEqual({ opts: { a: 1 } });
  });

  it("passes config and body through to expressions", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      config: { bucket: "b1" },
      body: { token: "t1" },
      expressions: [
        { targetFieldName: "bucket", modelEvaluationExpression: "config.bucket" },
        { targetFieldName: "token", modelEvaluationExpression: "body.token" },
      ],
    });
    expect(params).toEqual({ bucket: "b1", token: "t1" });
  });

  it("returns an empty object for an empty expression list", async () => {
    await expect(captureParameters({ evaluator, run, expressions: [] })).resolves.toEqual({});
  });

  it("propagates the evaluation failure with the expression named", async () => {
    await expect(
      captureParameters({
        evaluator,
        run,
        expressions: [{ targetFieldName: "x", modelEvaluationExpression: "workflowState.nope.deep" }],
      })
    ).rejects.toThrow(/workflowState\.nope\.deep/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- capture`
Expected: FAIL — module not found.

- [ ] **Step 3: Add lodash**

```bash
npm install lodash --workspace @wfe/core
npm install -D @types/lodash --workspace @wfe/core
```

- [ ] **Step 4: Implement**

`packages/core/src/expression/capture.ts`:

```typescript
import { ParameterCaptureExpression, WorkflowParameters, WorkflowRunLike } from "@wfe/sdk";
import { isEmpty, isObject, mergeWith, set } from "lodash";
import { ExpressionEvaluator } from "./evaluator";
import { toPlainSnapshot } from "./snapshot";

export interface CaptureOptions {
  evaluator: ExpressionEvaluator;
  run: WorkflowRunLike;
  expressions: ParameterCaptureExpression[];
  config?: Record<string, unknown>;
  body?: unknown;
}

/**
 * Evaluates a list of capture expressions against a run and merges the results
 * into one parameter object. Port of the original `captureFromModelConfigAndBody`.
 */
export async function captureParameters(opts: CaptureOptions): Promise<WorkflowParameters> {
  const { evaluator, run, expressions, config = {}, body } = opts;
  if (expressions.length === 0) {
    return {};
  }

  const workflowState = toPlainSnapshot(run);

  const captured: Array<Record<string, unknown>> = [];
  for (const { targetFieldName, modelEvaluationExpression } of expressions) {
    const value = await evaluator.evaluate(modelEvaluationExpression, {
      workflowState,
      config,
      body,
    });
    captured.push(set({}, targetFieldName, value));
  }

  // Keeps the left-hand value when the right-hand one is an empty object, so a
  // later expression yielding {} cannot erase an earlier populated result.
  const keepPopulated = (objValue: unknown, srcValue: unknown): unknown =>
    isObject(srcValue) && isEmpty(srcValue) ? objValue : undefined;

  return mergeWith({}, ...captured, keepPopulated) as WorkflowParameters;
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -w @wfe/core -- capture`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add capture expression evaluation and merge semantics"
```

---

### Task 6: Entities, migration and database context

**Files:**
- Create: `packages/core/src/entities/progress.ts`, `workflow-definition.ts`, `workflow-run.ts`, `step-run.ts`
- Create: `packages/core/src/db/naming.ts`, `packages/core/src/db/db-context.ts`, `packages/core/src/db/migrations/0001-init.ts`
- Create: `packages/core/src/config.ts`
- Modify: `packages/core/package.json` (add `typeorm`, `pg`, `reflect-metadata`, `typeorm-naming-strategies`; dev `@testcontainers/postgresql`)
- Test: `packages/core/test/db/persistence.test.ts`

**Interfaces:**
- Consumes: `WorkflowStatus`, `WorkflowRunLike`, `StepRunLike` from `@wfe/sdk`.
- Produces: entity classes `WorkflowDefinitionEntity`, `WorkflowRun`, `StepRun`, `Progress`; `EngineConfig` and `loadEngineConfig(env)`; `class DbContext { constructor(config: EngineConfig); getDataSource(): Promise<DataSource>; runMigrations(): Promise<void>; close(): Promise<void> }`. Tasks 7, 10, 11, 12 consume `DbContext` and the entities.

**Design note:** the jsonb shuttling is load-bearing. `inputs`/`outputs`/`state` are transient properties copied to and from the `*_json` columns by `@BeforeInsert`/`@BeforeUpdate`/`@AfterLoad`. Step ordering by `stepNumber` in `@AfterLoad` is likewise load-bearing — expression evaluation and step advancement both assume it.

- [ ] **Step 1: Write the failing test**

`packages/core/test/db/persistence.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { StepRun } from "../../src/entities/step-run";
import { WorkflowRun } from "../../src/entities/workflow-run";

jest.setTimeout(120000);

describe("persistence", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    db = new DbContext({ dbUrl: container.getConnectionUri(), showSql: false });
    await db.runMigrations();
  });

  afterAll(async () => {
    await db.close();
    await container.stop();
  });

  async function saveRun(): Promise<WorkflowRun> {
    const ds = await db.getDataSource();
    const run = new WorkflowRun();
    run.tenantId = "default";
    run.name = "three-step";
    run.version = "1.0.0";
    run.currentStep = -1;
    run.status = WorkflowStatus.STARTING;
    run.inputs = { jobId: "j-1" };
    run.outputs = {};
    run.state = {};
    run.stepRuns = [1, 0].map((n) => {
      const step = new StepRun();
      step.stepNumber = n;
      step.stepName = `Step${n}`;
      step.stepType = "core.noop";
      step.status = WorkflowStatus.NEW;
      step.inputs = {};
      step.outputs = {};
      step.state = {};
      return step;
    });
    return ds.getRepository(WorkflowRun).save(run);
  }

  it("round-trips transient parameters through the jsonb columns", async () => {
    const saved = await saveRun();
    const ds = await db.getDataSource();
    const loaded = await ds.getRepository(WorkflowRun).findOneByOrFail({ id: saved.id });
    expect(loaded.inputs).toEqual({ jobId: "j-1" });
    expect(loaded.state).toEqual({});
  });

  it("returns step runs sorted by step number regardless of insert order", async () => {
    const saved = await saveRun();
    const ds = await db.getDataSource();
    const loaded = await ds.getRepository(WorkflowRun).findOneByOrFail({ id: saved.id });
    expect(loaded.stepRuns!.map((s) => s.stepNumber)).toEqual([0, 1]);
  });

  it("ellipsizes an over-length step message instead of failing the write", async () => {
    const saved = await saveRun();
    const ds = await db.getDataSource();
    const step = saved.stepRuns![0];
    step.message = "x".repeat(9000);
    await ds.getRepository(StepRun).save(step);
    const loaded = await ds.getRepository(StepRun).findOneByOrFail({ id: step.id });
    expect(loaded.message!.length).toBeLessThanOrEqual(3900);
    expect(loaded.message!.endsWith("...")).toBe(true);
  });

  it("defaults tenantId to 'default'", async () => {
    const saved = await saveRun();
    expect(saved.tenantId).toBe("default");
  });

  it("writes run_id on cascaded step rows", async () => {
    const saved = await saveRun();
    const ds = await db.getDataSource();
    const rows = await ds.query("SELECT run_id FROM step_run WHERE run_id = $1", [saved.id]);
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- persistence`
Expected: FAIL — module not found.

- [ ] **Step 3: Install dependencies**

```bash
npm install typeorm pg reflect-metadata typeorm-naming-strategies --workspace @wfe/core
npm install -D @testcontainers/postgresql --workspace @wfe/core
```

- [ ] **Step 4: Write the config module**

`packages/core/src/config.ts`:

```typescript
export interface EngineConfig {
  dbUrl: string;
  showSql?: boolean;
  expressionTimeoutMs?: number;
  /** Config keys reachable from expressions. Everything else stays hidden. */
  expressionConfigKeys?: string[];
}

export function loadEngineConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const dbUrl = env.WFE_DB_URL;
  if (!dbUrl) {
    throw new Error("WFE_DB_URL is required");
  }
  return {
    dbUrl,
    showSql: env.WFE_SHOW_SQL === "true",
    expressionTimeoutMs: env.WFE_EXPRESSION_TIMEOUT_MS ? Number(env.WFE_EXPRESSION_TIMEOUT_MS) : 100,
    expressionConfigKeys: env.WFE_EXPRESSION_CONFIG_KEYS?.split(",").map((k) => k.trim()).filter(Boolean) ?? [],
  };
}
```

- [ ] **Step 5: Write the entities**

`packages/core/src/entities/progress.ts`:

```typescript
import { StepProgress } from "@wfe/sdk";
import { Column } from "typeorm";

export class Progress implements StepProgress {
  @Column({ type: "varchar", length: 50, nullable: true })
  units?: string;

  @Column({ type: "bigint", nullable: true })
  totalExpected?: number;

  @Column({ type: "bigint", nullable: true })
  currentProgress?: number;
}
```

`packages/core/src/entities/workflow-definition.ts`:

```typescript
import { WorkflowDefinitionBody, WorkflowDefinitionStatus } from "@wfe/sdk";
import {
  Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn,
} from "typeorm";

@Entity({ name: "workflow_definition" })
@Unique("uq_workflow_definition", ["tenantId", "name", "version"])
export class WorkflowDefinitionEntity {
  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: "varchar", length: 64, nullable: false, default: "default" })
  tenantId!: string;

  @Column({ type: "varchar", length: 255, nullable: false })
  name!: string;

  @Column({ type: "varchar", length: 20, nullable: false })
  version!: string;

  @Column({ type: "varchar", length: 20, nullable: false, default: WorkflowDefinitionStatus.DRAFT })
  status!: WorkflowDefinitionStatus;

  @Column({ type: "jsonb", nullable: false })
  definition!: WorkflowDefinitionBody;

  @Column({ type: "jsonb", nullable: true })
  lastUpdateHistory?: Record<string, unknown>;

  @CreateDateColumn()
  createdDate!: Date;

  @UpdateDateColumn()
  updatedDate!: Date;
}
```

`packages/core/src/entities/workflow-run.ts`:

```typescript
import { WorkflowParameters, WorkflowRunLike, WorkflowStatus } from "@wfe/sdk";
import {
  AfterLoad, BeforeInsert, BeforeUpdate, Column, CreateDateColumn, Entity, OneToMany,
  PrimaryGeneratedColumn, UpdateDateColumn,
} from "typeorm";
import { StepRun } from "./step-run";

@Entity({ name: "workflow_run" })
export class WorkflowRun implements WorkflowRunLike {
  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: "varchar", length: 64, nullable: false, default: "default" })
  tenantId!: string;

  @Column({ type: "int", nullable: true })
  definitionId?: number;

  @Column({ type: "varchar", length: 256, nullable: false })
  name!: string;

  @Column({ type: "varchar", length: 50, nullable: false })
  version!: string;

  @Column({ type: "int", nullable: false })
  currentStep!: number;

  @Column({ type: "varchar", length: 50, nullable: false })
  status!: WorkflowStatus;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  inputsJson?: WorkflowParameters;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  outputsJson?: WorkflowParameters;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  stateJson?: WorkflowParameters;

  @OneToMany(() => StepRun, (step) => step.run, { eager: true, cascade: true })
  stepRuns?: StepRun[];

  // Transient — shuttled to and from the jsonb columns.
  inputs: WorkflowParameters = {};
  outputs: WorkflowParameters = {};
  state: WorkflowParameters = {};

  @BeforeInsert()
  @BeforeUpdate()
  copyParametersToJson(): void {
    this.inputsJson = this.inputs;
    this.outputsJson = this.outputs;
    this.stateJson = this.state;
  }

  @AfterLoad()
  loadParametersFromJson(): void {
    this.inputs = this.inputsJson ?? {};
    this.outputs = this.outputsJson ?? {};
    this.state = this.stateJson ?? {};
    this.stepRuns = this.stepRuns?.sort((a, b) => a.stepNumber - b.stepNumber);
  }

  @CreateDateColumn()
  createdDate!: Date;

  @UpdateDateColumn()
  updatedDate!: Date;
}
```

`packages/core/src/entities/step-run.ts`:

```typescript
import { StepRunLike, WorkflowParameters, WorkflowStatus } from "@wfe/sdk";
import {
  AfterLoad, BeforeInsert, BeforeUpdate, Column, CreateDateColumn, Entity, JoinColumn,
  ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn,
} from "typeorm";
import { Progress } from "./progress";
import { WorkflowRun } from "./workflow-run";

// Caps the human-facing message before persist so an over-length message cannot
// overflow the column and mask the real error with a database write error. Full
// detail always remains in outputsJson. The margin below the 4000-character column
// accounts for the appended ellipsis and for UTF-16 code units vs characters.
const MAX_MESSAGE_LENGTH = 3900;

@Entity({ name: "step_run" })
export class StepRun implements StepRunLike {
  @PrimaryGeneratedColumn()
  id?: number;

  // Written by the cascade insert from WorkflowRun; the FK is declared on the
  // relation below via @JoinColumn, so this must not claim the column itself.
  @Column({ type: "int", nullable: true })
  runId?: number;

  @Column({ type: "int", nullable: false })
  stepNumber!: number;

  @Column({ type: "varchar", length: 200, nullable: false })
  stepName!: string;

  @Column({ type: "varchar", length: 200, nullable: false })
  stepType!: string;

  @Column({ type: "varchar", length: 50, nullable: false })
  status!: WorkflowStatus;

  @Column({ type: "varchar", length: 4000, nullable: true })
  message?: string;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  inputsJson?: WorkflowParameters;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  outputsJson?: WorkflowParameters;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  stateJson?: WorkflowParameters;

  @Column({ type: "text", nullable: true })
  externalServiceName?: string;

  @Column({ type: "text", nullable: true })
  targetAgent?: string;

  @Column({ type: "int", nullable: true })
  priority?: number;

  @Column({ type: "text", nullable: true })
  remoteTaskStatus?: string;

  @Column({ type: "int", nullable: true })
  originalRunId?: number;

  @Column({ type: "timestamptz", nullable: true })
  lastStepAction?: Date;

  @Column(() => Progress)
  progress?: Progress;

  @ManyToOne(() => WorkflowRun, (run) => run.stepRuns, { onDelete: "CASCADE" })
  @JoinColumn({ name: "run_id" })
  run?: WorkflowRun;

  inputs: WorkflowParameters = {};
  outputs: WorkflowParameters = {};
  state: WorkflowParameters = {};

  @BeforeInsert()
  @BeforeUpdate()
  copyParametersToJson(): void {
    this.inputsJson = this.inputs;
    this.outputsJson = this.outputs;
    this.stateJson = this.state;
  }

  @BeforeInsert()
  @BeforeUpdate()
  truncateMessage(): void {
    if (this.message && this.message.length > MAX_MESSAGE_LENGTH) {
      this.message = `${this.message.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
    }
  }

  @AfterLoad()
  loadParametersFromJson(): void {
    this.inputs = this.inputsJson ?? {};
    this.outputs = this.outputsJson ?? {};
    this.state = this.stateJson ?? {};
  }

  @CreateDateColumn()
  createdDate!: Date;

  @UpdateDateColumn()
  updatedDate!: Date;
}
```

- [ ] **Step 6: Write the migration**

`packages/core/src/db/migrations/0001-init.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class Init0001 implements MigrationInterface {
  name = "Init0001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE workflow_definition (
        id SERIAL PRIMARY KEY,
        tenant_id varchar(64) NOT NULL DEFAULT 'default',
        name varchar(255) NOT NULL,
        version varchar(20) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'draft',
        definition jsonb NOT NULL,
        last_update_history jsonb,
        created_date TIMESTAMP NOT NULL DEFAULT now(),
        updated_date TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT uq_workflow_definition UNIQUE (tenant_id, name, version)
      )`);

    await queryRunner.query(`
      CREATE TABLE workflow_run (
        id SERIAL PRIMARY KEY,
        tenant_id varchar(64) NOT NULL DEFAULT 'default',
        definition_id integer REFERENCES workflow_definition(id),
        name varchar(256) NOT NULL,
        version varchar(50) NOT NULL,
        current_step integer NOT NULL,
        status varchar(50) NOT NULL,
        inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        outputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_date TIMESTAMP NOT NULL DEFAULT now(),
        updated_date TIMESTAMP NOT NULL DEFAULT now()
      )`);

    await queryRunner.query(
      `CREATE INDEX idx_workflow_run_tenant_status ON workflow_run (tenant_id, status, updated_date)`
    );
    await queryRunner.query(
      `CREATE INDEX idx_workflow_run_tenant_name ON workflow_run (tenant_id, name, version)`
    );
    await queryRunner.query(
      `CREATE INDEX idx_workflow_run_inputs ON workflow_run USING GIN (inputs_json)`
    );

    await queryRunner.query(`
      CREATE TABLE step_run (
        id SERIAL PRIMARY KEY,
        run_id integer NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
        step_number integer NOT NULL,
        step_name varchar(200) NOT NULL,
        step_type varchar(200) NOT NULL,
        status varchar(50) NOT NULL,
        message varchar(4000),
        inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        outputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        external_service_name text,
        target_agent text,
        priority integer,
        remote_task_status text,
        original_run_id integer,
        last_step_action timestamptz,
        progress_units varchar(50),
        progress_total_expected bigint,
        progress_current_progress bigint,
        created_date TIMESTAMP NOT NULL DEFAULT now(),
        updated_date TIMESTAMP NOT NULL DEFAULT now()
      )`);

    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_step_run_run_step ON step_run (run_id, step_number)`
    );
    await queryRunner.query(
      `CREATE INDEX idx_step_run_claim ON step_run (status, external_service_name, priority)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS step_run CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS workflow_run CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS workflow_definition CASCADE`);
  }
}
```

- [ ] **Step 7: Write the database context**

`packages/core/src/db/db-context.ts`:

```typescript
import "reflect-metadata";
import { DataSource, DataSourceOptions } from "typeorm";
import { SnakeNamingStrategy } from "typeorm-naming-strategies";
import { EngineConfig } from "../config";
import { StepRun } from "../entities/step-run";
import { WorkflowDefinitionEntity } from "../entities/workflow-definition";
import { WorkflowRun } from "../entities/workflow-run";
import { Init0001 } from "./migrations/0001-init";

export function connectionOptions(config: EngineConfig): DataSourceOptions {
  return {
    type: "postgres",
    url: config.dbUrl,
    namingStrategy: new SnakeNamingStrategy(),
    entities: [WorkflowDefinitionEntity, WorkflowRun, StepRun],
    migrations: [Init0001],
    synchronize: false,
    logging: config.showSql ?? false,
  };
}

export class DbContext {
  private dataSource?: DataSource;

  constructor(private readonly config: EngineConfig) {}

  async getDataSource(): Promise<DataSource> {
    if (!this.dataSource) {
      this.dataSource = await new DataSource(connectionOptions(this.config)).initialize();
    }
    return this.dataSource;
  }

  async runMigrations(): Promise<void> {
    const ds = await this.getDataSource();
    await ds.runMigrations({ transaction: "each" });
  }

  async close(): Promise<void> {
    if (this.dataSource?.isInitialized) {
      await this.dataSource.destroy();
    }
    this.dataSource = undefined;
  }
}
```

Entities and migrations are listed explicitly rather than by glob: globs break once the package is published and consumed from `dist`.

- [ ] **Step 8: Run tests**

Run: `npm test -w @wfe/core -- persistence`
Expected: PASS — 5 tests. Docker must be running for testcontainers.

- [ ] **Step 9: Commit**

```bash
git add packages/core
git commit -m "feat(core): add entities, init migration and database context"
```

---

### Task 7: Repositories

**Files:**
- Create: `packages/core/src/repositories/definition-repository.ts`, `packages/core/src/repositories/run-repository.ts`
- Test: `packages/core/test/repositories/repositories.test.ts`

**Interfaces:**
- Consumes: `DbContext`, entities (Task 6).
- Produces:
  - `class DefinitionRepository { constructor(db: DbContext); create(input: { tenantId, name, version, definition, status? }): Promise<WorkflowDefinitionEntity>; findById(tenantId, id): Promise<WorkflowDefinitionEntity | null>; findLatestPublished(tenantId, name, version): Promise<WorkflowDefinitionEntity | null> }`
  - `class RunRepository { constructor(db: DbContext); save(run: WorkflowRun): Promise<WorkflowRun>; findById(tenantId, id): Promise<WorkflowRun | null> }`
- Tasks 10, 11, 12 use both.

- [ ] **Step 1: Write the failing test**

`packages/core/test/repositories/repositories.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { WorkflowRun } from "../../src/entities/workflow-run";
import { DefinitionRepository } from "../../src/repositories/definition-repository";
import { RunRepository } from "../../src/repositories/run-repository";

jest.setTimeout(120000);

describe("repositories", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let definitions: DefinitionRepository;
  let runs: RunRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    db = new DbContext({ dbUrl: container.getConnectionUri() });
    await db.runMigrations();
    definitions = new DefinitionRepository(db);
    runs = new RunRepository(db);
  });

  afterAll(async () => {
    await db.close();
    await container.stop();
  });

  const body = { steps: [] };

  it("creates and reads back a definition", async () => {
    const created = await definitions.create({
      tenantId: "default", name: "wf-a", version: "1.0.0", definition: body,
    });
    const found = await definitions.findById("default", created.id!);
    expect(found?.name).toBe("wf-a");
    expect(found?.status).toBe(WorkflowDefinitionStatus.DRAFT);
  });

  it("does not return a definition belonging to another tenant", async () => {
    const created = await definitions.create({
      tenantId: "tenant-a", name: "wf-b", version: "1.0.0", definition: body,
    });
    await expect(definitions.findById("tenant-b", created.id!)).resolves.toBeNull();
  });

  it("finds the published definition by name and version", async () => {
    await definitions.create({
      tenantId: "default", name: "wf-c", version: "1.0.0",
      definition: body, status: WorkflowDefinitionStatus.PUBLISHED,
    });
    const found = await definitions.findLatestPublished("default", "wf-c", "1.0.0");
    expect(found?.name).toBe("wf-c");
  });

  it("ignores a draft when looking for a published definition", async () => {
    await definitions.create({
      tenantId: "default", name: "wf-d", version: "1.0.0", definition: body,
    });
    await expect(definitions.findLatestPublished("default", "wf-d", "1.0.0")).resolves.toBeNull();
  });

  it("saves a run and reads it back with its steps", async () => {
    const run = new WorkflowRun();
    run.tenantId = "default";
    run.name = "wf-a";
    run.version = "1.0.0";
    run.currentStep = -1;
    run.status = WorkflowStatus.STARTING;
    run.inputs = { a: 1 };
    const saved = await runs.save(run);
    const found = await runs.findById("default", saved.id!);
    expect(found?.inputs).toEqual({ a: 1 });
  });

  it("does not return a run belonging to another tenant", async () => {
    const run = new WorkflowRun();
    run.tenantId = "tenant-a";
    run.name = "wf-a";
    run.version = "1.0.0";
    run.currentStep = -1;
    run.status = WorkflowStatus.STARTING;
    const saved = await runs.save(run);
    await expect(runs.findById("tenant-b", saved.id!)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- repositories`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the definition repository**

`packages/core/src/repositories/definition-repository.ts`:

```typescript
import { WorkflowDefinitionBody, WorkflowDefinitionStatus } from "@wfe/sdk";
import { DbContext } from "../db/db-context";
import { WorkflowDefinitionEntity } from "../entities/workflow-definition";

export interface CreateDefinitionInput {
  tenantId: string;
  name: string;
  version: string;
  definition: WorkflowDefinitionBody;
  status?: WorkflowDefinitionStatus;
}

export class DefinitionRepository {
  constructor(private readonly db: DbContext) {}

  async create(input: CreateDefinitionInput): Promise<WorkflowDefinitionEntity> {
    const ds = await this.db.getDataSource();
    const entity = new WorkflowDefinitionEntity();
    entity.tenantId = input.tenantId;
    entity.name = input.name;
    entity.version = input.version;
    entity.definition = input.definition;
    entity.status = input.status ?? WorkflowDefinitionStatus.DRAFT;
    return ds.getRepository(WorkflowDefinitionEntity).save(entity);
  }

  async findById(tenantId: string, id: number): Promise<WorkflowDefinitionEntity | null> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowDefinitionEntity).findOneBy({ id, tenantId });
  }

  async findLatestPublished(
    tenantId: string,
    name: string,
    version: string
  ): Promise<WorkflowDefinitionEntity | null> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowDefinitionEntity).findOneBy({
      tenantId,
      name,
      version,
      status: WorkflowDefinitionStatus.PUBLISHED,
    });
  }
}
```

- [ ] **Step 4: Implement the run repository**

`packages/core/src/repositories/run-repository.ts`:

```typescript
import { DbContext } from "../db/db-context";
import { WorkflowRun } from "../entities/workflow-run";

export class RunRepository {
  constructor(private readonly db: DbContext) {}

  async save(run: WorkflowRun): Promise<WorkflowRun> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowRun).save(run);
  }

  async findById(tenantId: string, id: number): Promise<WorkflowRun | null> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowRun).findOne({ where: { id, tenantId } });
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -w @wfe/core -- repositories`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add tenant-scoped definition and run repositories"
```

---

### Task 8: Step registry and built-in steps

**Files:**
- Create: `packages/core/src/registry/step-registry.ts`, `packages/core/src/steps/noop-step.ts`, `packages/core/src/steps/transform-step.ts`
- Test: `packages/core/test/registry/step-registry.test.ts`

**Interfaces:**
- Consumes: `BaseStep`, `StepFactory`, `StepParams`, `StepContext`, `RunStepResponse`, `WorkflowStatus` from `@wfe/sdk`.
- Produces: `interface StepRegistration { type: string; version: string; factory: StepFactory; description?: string }`; `class StepRegistry { register(reg: StepRegistration): void; has(type: string): boolean; create(type: string, params: StepParams): BaseStep; list(): StepRegistration[] }`; `registerBuiltInSteps(registry): void` registering `core.noop` and `core.transform`. Tasks 9, 10, 11 consume the registry.

**Design note:** `core.transform` is the step that makes a purely declarative workflow useful — it takes whatever the executor resolved from its capture expressions and writes it straight to outputs. No custom code required.

- [ ] **Step 1: Write the failing test**

`packages/core/test/registry/step-registry.test.ts`:

```typescript
import { BaseStep, RunStepResponse, StepContext, StepParams, WorkflowStatus } from "@wfe/sdk";
import { StepRegistry, registerBuiltInSteps } from "../../src/registry/step-registry";

class DummyStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

function context(inputs: Record<string, unknown>): StepContext {
  return {
    config: {},
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    services: {},
    inputs,
    stepNumber: 0,
    run: {
      tenantId: "default", name: "t", version: "1.0.0", currentStep: 0,
      status: WorkflowStatus.RUNNING, inputs: {}, outputs: {}, state: {},
    },
    step: {
      stepNumber: 0, stepName: "S", stepType: "core.transform",
      status: WorkflowStatus.RUNNING, inputs: {}, outputs: {}, state: {},
    },
  };
}

describe("StepRegistry", () => {
  const params: StepParams = { name: "S", version: "1.0.0", type: "test.dummy" };

  it("registers and creates a step by type", () => {
    const registry = new StepRegistry();
    registry.register({ type: "test.dummy", version: "1.0.0", factory: (p) => new DummyStep(p) });
    expect(registry.has("test.dummy")).toBe(true);
    expect(registry.create("test.dummy", params)).toBeInstanceOf(DummyStep);
  });

  it("rejects a duplicate registration", () => {
    const registry = new StepRegistry();
    const reg = { type: "test.dummy", version: "1.0.0", factory: (p: StepParams) => new DummyStep(p) };
    registry.register(reg);
    expect(() => registry.register(reg)).toThrow(/already registered/);
  });

  it("throws a helpful error for an unknown type", () => {
    const registry = new StepRegistry();
    expect(() => registry.create("nope.missing", params)).toThrow(/nope\.missing/);
  });

  it("lists registrations", () => {
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    expect(registry.list().map((r) => r.type).sort()).toEqual(["core.noop", "core.transform"]);
  });

  it("core.transform copies resolved inputs to outputs and completes", async () => {
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    const step = registry.create("core.transform", { ...params, type: "core.transform" });
    const ctx = context({ total: 12, label: "ready" });
    const response = await step.run(ctx);
    expect(response.stepState.outputs).toEqual({ total: 12, label: "ready" });
    expect(response.stepState.status).toBe(WorkflowStatus.COMPLETE);
  });

  it("core.noop completes without producing outputs", async () => {
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    const step = registry.create("core.noop", { ...params, type: "core.noop" });
    const response = await step.run(context({ ignored: true }));
    expect(response.stepState.outputs).toEqual({});
    expect(response.stepState.status).toBe(WorkflowStatus.COMPLETE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- step-registry`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

`packages/core/src/registry/step-registry.ts`:

```typescript
import { BaseStep, StepFactory, StepParams } from "@wfe/sdk";
import { WfeError } from "../errors";
import { NoopStep } from "../steps/noop-step";
import { TransformStep } from "../steps/transform-step";

export interface StepRegistration {
  type: string;
  version: string;
  factory: StepFactory;
  description?: string;
}

export class StepRegistry {
  private readonly registrations = new Map<string, StepRegistration>();

  register(registration: StepRegistration): void {
    if (this.registrations.has(registration.type)) {
      throw new WfeError(`Step type "${registration.type}" is already registered`, {
        statusCode: 409,
        code: "STEP_TYPE_DUPLICATE",
      });
    }
    this.registrations.set(registration.type, registration);
  }

  has(type: string): boolean {
    return this.registrations.has(type);
  }

  create(type: string, params: StepParams): BaseStep {
    const registration = this.registrations.get(type);
    if (!registration) {
      throw new WfeError(
        `Unknown step type "${type}". Registered types: ${[...this.registrations.keys()].join(", ") || "none"}`,
        { statusCode: 400, code: "STEP_TYPE_UNKNOWN" }
      );
    }
    return registration.factory({ ...params, type });
  }

  list(): StepRegistration[] {
    return [...this.registrations.values()];
  }
}

export function registerBuiltInSteps(registry: StepRegistry): void {
  registry.register({
    type: "core.noop",
    version: "1.0.0",
    description: "Completes immediately without doing anything.",
    factory: (params) => new NoopStep(params),
  });
  registry.register({
    type: "core.transform",
    version: "1.0.0",
    description: "Writes its resolved inputs straight to its outputs.",
    factory: (params) => new TransformStep(params),
  });
}
```

- [ ] **Step 4: Implement the built-in steps**

`packages/core/src/steps/noop-step.ts`:

```typescript
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

export class NoopStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
```

`packages/core/src/steps/transform-step.ts`:

```typescript
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

/**
 * Pure state reshape: whatever the step's capture expressions resolved to becomes
 * the step's outputs, so a definition can move and rename values with no code.
 */
export class TransformStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.outputs = { ...ctx.inputs };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -w @wfe/core -- step-registry`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add step registry with core.noop and core.transform built-ins"
```

---

### Task 9: Definition validation

**Files:**
- Create: `packages/core/src/registry/validate.ts`
- Modify: `packages/core/package.json` (add `yup`)
- Test: `packages/core/test/registry/validate.test.ts`

**Interfaces:**
- Consumes: `StepRegistry` (Task 8), `WorkflowDefinitionBody`, `StepDefinition`, `resolveStepType` (Task 2), `WfeError` (Task 4).
- Produces: `validateDefinitionShape(body: unknown): Promise<WorkflowDefinitionBody>` and `validateAgainstRegistry(body: WorkflowDefinitionBody, registry: StepRegistry): void`. Task 10 calls both before materializing a run.

- [ ] **Step 1: Write the failing test**

`packages/core/test/registry/validate.test.ts`:

```typescript
import { StepRegistry, registerBuiltInSteps } from "../../src/registry/step-registry";
import { validateAgainstRegistry, validateDefinitionShape } from "../../src/registry/validate";

const valid = {
  steps: [
    {
      stepName: "Prepare",
      stepVersion: "1.0.0",
      stepType: "core.transform",
      stepInputs: [{ targetFieldName: "jobId", modelEvaluationExpression: "workflowState.inputs.jobId" }],
    },
  ],
};

describe("definition validation", () => {
  it("accepts a well-formed definition", async () => {
    await expect(validateDefinitionShape(valid)).resolves.toMatchObject({ steps: expect.any(Array) });
  });

  it("rejects a definition with no steps array", async () => {
    await expect(validateDefinitionShape({})).rejects.toThrow();
  });

  it("rejects a step missing its inputs array", async () => {
    await expect(
      validateDefinitionShape({ steps: [{ stepName: "A", stepVersion: "1.0.0", stepType: "core.noop" }] })
    ).rejects.toThrow();
  });

  it("accepts the legacy stepClassName alias", async () => {
    const legacy = {
      steps: [
        { stepName: "Prepare", stepVersion: "1.0.0", stepClassName: "core.transform",
          stepFileName: "ignored", stepInputs: [] },
      ],
    };
    const parsed = await validateDefinitionShape(legacy);
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    expect(() => validateAgainstRegistry(parsed, registry)).not.toThrow();
  });

  it("rejects a step type that is not registered", async () => {
    const parsed = await validateDefinitionShape({
      steps: [{ stepName: "Ghost", stepVersion: "1.0.0", stepType: "vendor.ghost", stepInputs: [] }],
    });
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    expect(() => validateAgainstRegistry(parsed, registry)).toThrow(/vendor\.ghost/);
  });

  it("rejects duplicate step names, which would break name-based addressing", async () => {
    const parsed = await validateDefinitionShape({
      steps: [
        { stepName: "Same", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
        { stepName: "Same", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
      ],
    });
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    expect(() => validateAgainstRegistry(parsed, registry)).toThrow(/Same/);
  });
});
```

The duplicate-name check is new. The original engine allowed duplicates, and the `namedSteps` map silently kept only the last one — a real trap for definition authors.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- validate`
Expected: FAIL — module not found.

- [ ] **Step 3: Install yup**

```bash
npm install yup --workspace @wfe/core
```

- [ ] **Step 4: Implement**

`packages/core/src/registry/validate.ts`:

```typescript
import { PreFlightCheckActionOutcome, WorkflowDefinitionBody, resolveStepType } from "@wfe/sdk";
import { array, mixed, object, string } from "yup";
import { WfeError } from "../errors";
import { StepRegistry } from "./step-registry";

const captureExpressionSchema = object({
  targetFieldName: string().required(),
  modelEvaluationExpression: string().required(),
});

const stepSchema = object({
  stepName: string().min(1).max(200).required(),
  stepVersion: string().min(1).max(20).required(),
  stepType: string().optional(),
  stepClassName: string().optional(),
  stepFileName: string().optional(),
  stepInputs: array().of(captureExpressionSchema).required(),
  stepOutputs: array().of(captureExpressionSchema).optional(),
  stepStateCapture: array().of(captureExpressionSchema).optional(),
  externalServiceName: string().optional(),
  preFlightCheck: object({
    conditionsToCheck: array().of(captureExpressionSchema).required(),
    actionOnFailure: mixed<PreFlightCheckActionOutcome>()
      .oneOf(Object.values(PreFlightCheckActionOutcome))
      .required(),
    failureMessage: string().optional(),
  }).default(undefined),
});

const definitionSchema = object({
  steps: array().of(stepSchema).min(1).required(),
});

export async function validateDefinitionShape(body: unknown): Promise<WorkflowDefinitionBody> {
  try {
    return (await definitionSchema.validate(body, { abortEarly: false, stripUnknown: false })) as WorkflowDefinitionBody;
  } catch (err) {
    throw new WfeError(`Invalid workflow definition: ${(err as Error).message}`, {
      statusCode: 400,
      code: "DEFINITION_INVALID",
    });
  }
}

/** Rejects a definition that names an unregistered step type or reuses a step name. */
export function validateAgainstRegistry(body: WorkflowDefinitionBody, registry: StepRegistry): void {
  const seen = new Set<string>();
  for (const step of body.steps) {
    if (seen.has(step.stepName)) {
      throw new WfeError(
        `Duplicate step name "${step.stepName}" — step names must be unique so expressions can address steps by name`,
        { statusCode: 400, code: "DEFINITION_DUPLICATE_STEP_NAME" }
      );
    }
    seen.add(step.stepName);

    const type = resolveStepType(step);
    if (!registry.has(type)) {
      throw new WfeError(
        `Step "${step.stepName}" references unregistered step type "${type}"`,
        { statusCode: 400, code: "DEFINITION_UNKNOWN_STEP_TYPE" }
      );
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -w @wfe/core -- validate`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): validate definition shape and step types against the registry"
```

---

### Task 10: WorkflowManager.startWorkflow

**Files:**
- Create: `packages/core/src/logging.ts`, `packages/core/src/engine/workflow-manager.ts`
- Modify: `packages/core/package.json` (add `pino`)
- Test: `packages/core/test/engine/start-workflow.test.ts`

**Interfaces:**
- Consumes: `DefinitionRepository`, `RunRepository` (Task 7), `StepRegistry` (Task 8), validation (Task 9), entities (Task 6).
- Produces: `createLogger(name): Logger`; `interface EngineDeps { config, db, registry, evaluator, services?, logger? }`; `class WorkflowManager { constructor(deps: EngineDeps); startWorkflow(input: { tenantId, name, version, inputs, definitionId? }): Promise<number> }`. Tasks 11 and 12 extend this class's surface.

**Design note:** `startWorkflow` materializes the run and every step row up front, with `currentStep = -1` and status `STARTING`. Nothing executes yet — Task 11 supplies execution. Keeping creation and execution separate is what lets a run be created by one process and advanced by another.

- [ ] **Step 1: Write the failing test**

`packages/core/test/engine/start-workflow.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { WorkflowManager } from "../../src/engine/workflow-manager";
import { ExpressionEvaluator } from "../../src/expression/evaluator";
import { StepRegistry, registerBuiltInSteps } from "../../src/registry/step-registry";
import { DefinitionRepository } from "../../src/repositories/definition-repository";
import { RunRepository } from "../../src/repositories/run-repository";

jest.setTimeout(120000);

const definition = {
  steps: [
    { stepName: "First", stepVersion: "1.0.0", stepType: "core.transform",
      stepInputs: [{ targetFieldName: "jobId", modelEvaluationExpression: "workflowState.inputs.jobId" }] },
    { stepName: "Second", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
  ],
};

describe("WorkflowManager.startWorkflow", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let manager: WorkflowManager;
  let runs: RunRepository;
  let evaluator: ExpressionEvaluator;
  let definitionId: number;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    manager = new WorkflowManager({ config, db, registry, evaluator });
    runs = new RunRepository(db);

    const created = await new DefinitionRepository(db).create({
      tenantId: "default", name: "two-step", version: "1.0.0",
      definition, status: WorkflowDefinitionStatus.PUBLISHED,
    });
    definitionId = created.id!;
  });

  afterAll(async () => {
    evaluator.dispose();
    await db.close();
    await container.stop();
  });

  it("creates a run with one step row per definition step", async () => {
    const runId = await manager.startWorkflow({
      tenantId: "default", name: "two-step", version: "1.0.0", inputs: { jobId: "j-9" },
    });
    const run = await runs.findById("default", runId);
    expect(run!.stepRuns).toHaveLength(2);
    expect(run!.stepRuns!.map((s) => s.stepName)).toEqual(["First", "Second"]);
    expect(run!.stepRuns!.map((s) => s.stepNumber)).toEqual([0, 1]);
  });

  it("starts at currentStep -1 with status STARTING and every step NEW", async () => {
    const runId = await manager.startWorkflow({
      tenantId: "default", name: "two-step", version: "1.0.0", inputs: {},
    });
    const run = await runs.findById("default", runId);
    expect(run!.currentStep).toBe(-1);
    expect(run!.status).toBe(WorkflowStatus.STARTING);
    expect(run!.stepRuns!.every((s) => s.status === WorkflowStatus.NEW)).toBe(true);
  });

  it("records the definition id and the supplied inputs", async () => {
    const runId = await manager.startWorkflow({
      tenantId: "default", name: "two-step", version: "1.0.0", inputs: { jobId: "j-1" },
    });
    const run = await runs.findById("default", runId);
    expect(run!.definitionId).toBe(definitionId);
    expect(run!.inputs).toEqual({ jobId: "j-1" });
  });

  it("fails when no published definition matches", async () => {
    await expect(
      manager.startWorkflow({ tenantId: "default", name: "missing", version: "1.0.0", inputs: {} })
    ).rejects.toThrow(/missing/);
  });

  it("fails when the definition references an unregistered step type", async () => {
    await new DefinitionRepository(db).create({
      tenantId: "default", name: "bad-wf", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: { steps: [{ stepName: "X", stepVersion: "1.0.0", stepType: "vendor.nope", stepInputs: [] }] },
    });
    await expect(
      manager.startWorkflow({ tenantId: "default", name: "bad-wf", version: "1.0.0", inputs: {} })
    ).rejects.toThrow(/vendor\.nope/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- start-workflow`
Expected: FAIL — module not found.

- [ ] **Step 3: Install pino and write the logger factory**

```bash
npm install pino --workspace @wfe/core
```

`packages/core/src/logging.ts`:

```typescript
import { Logger, LogFields } from "@wfe/sdk";
import pino from "pino";

const root = pino({ level: process.env.WFE_LOG_LEVEL ?? "info" });

export function createLogger(name: string): Logger {
  const child = root.child({ component: name });
  return {
    debug: (message: string, fields?: LogFields) => child.debug(fields ?? {}, message),
    info: (message: string, fields?: LogFields) => child.info(fields ?? {}, message),
    warn: (message: string, fields?: LogFields) => child.warn(fields ?? {}, message),
    error: (message: string, fields?: LogFields) => child.error(fields ?? {}, message),
  };
}
```

- [ ] **Step 4: Implement the manager**

`packages/core/src/engine/workflow-manager.ts`:

```typescript
import {
  Logger, WorkflowParameters, WorkflowStatus, resolveStepType,
} from "@wfe/sdk";
import { EngineConfig } from "../config";
import { DbContext } from "../db/db-context";
import { StepRun } from "../entities/step-run";
import { WorkflowDefinitionEntity } from "../entities/workflow-definition";
import { WorkflowRun } from "../entities/workflow-run";
import { WfeError } from "../errors";
import { ExpressionEvaluator } from "../expression/evaluator";
import { createLogger } from "../logging";
import { StepRegistry } from "../registry/step-registry";
import { validateAgainstRegistry } from "../registry/validate";
import { DefinitionRepository } from "../repositories/definition-repository";
import { RunRepository } from "../repositories/run-repository";

export interface EngineDeps {
  config: EngineConfig;
  db: DbContext;
  registry: StepRegistry;
  evaluator: ExpressionEvaluator;
  services?: Record<string, unknown>;
  logger?: Logger;
}

export interface StartWorkflowInput {
  tenantId: string;
  name: string;
  version: string;
  inputs: WorkflowParameters;
  definitionId?: number;
}

export class WorkflowManager {
  protected readonly config: EngineConfig;
  protected readonly db: DbContext;
  protected readonly registry: StepRegistry;
  protected readonly evaluator: ExpressionEvaluator;
  protected readonly services: Record<string, unknown>;
  protected readonly log: Logger;
  protected readonly definitions: DefinitionRepository;
  protected readonly runs: RunRepository;

  constructor(deps: EngineDeps) {
    this.config = deps.config;
    this.db = deps.db;
    this.registry = deps.registry;
    this.evaluator = deps.evaluator;
    this.services = deps.services ?? {};
    this.log = deps.logger ?? createLogger("workflow-manager");
    this.definitions = new DefinitionRepository(deps.db);
    this.runs = new RunRepository(deps.db);
  }

  protected async lookupDefinition(input: StartWorkflowInput): Promise<WorkflowDefinitionEntity> {
    const found = input.definitionId
      ? await this.definitions.findById(input.tenantId, input.definitionId)
      : await this.definitions.findLatestPublished(input.tenantId, input.name, input.version);

    if (!found) {
      throw new WfeError(
        `No published workflow definition found for name="${input.name}" version="${input.version}"`,
        { statusCode: 404, code: "DEFINITION_NOT_FOUND" }
      );
    }
    return found;
  }

  /**
   * Materializes a run and one step row per definition step. Nothing executes
   * here — the run is left at currentStep -1 for the executor to pick up.
   */
  async startWorkflow(input: StartWorkflowInput): Promise<number> {
    const definition = await this.lookupDefinition(input);
    validateAgainstRegistry(definition.definition, this.registry);

    const run = new WorkflowRun();
    run.tenantId = input.tenantId;
    run.definitionId = definition.id;
    run.name = input.name;
    run.version = input.version;
    run.currentStep = -1;
    run.status = WorkflowStatus.STARTING;
    run.inputs = input.inputs;
    run.outputs = {};
    run.state = {};
    run.stepRuns = definition.definition.steps.map((stepDefinition, index) => {
      const step = new StepRun();
      step.stepNumber = index;
      step.stepName = stepDefinition.stepName;
      step.stepType = resolveStepType(stepDefinition);
      step.status = WorkflowStatus.NEW;
      step.externalServiceName = stepDefinition.externalServiceName;
      step.inputs = {};
      step.outputs = {};
      step.state = {};
      step.lastStepAction = new Date();
      return step;
    });

    const saved = await this.runs.save(run);
    this.log.info("Created workflow run", {
      runId: saved.id, name: input.name, version: input.version, tenantId: input.tenantId,
    });
    return saved.id!;
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -w @wfe/core -- start-workflow`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add WorkflowManager.startWorkflow run materialization"
```

---

### Task 11: Execute a single step

**Files:**
- Create: `packages/core/src/engine/run-executor.ts`
- Test: `packages/core/test/engine/execute-step.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–10.
- Produces: `class RunExecutor extends WorkflowManager { executeStep(run: WorkflowRun, stepNumber: number, body?: unknown): Promise<{ run: WorkflowRun; delaySeconds?: number }> }`. Task 12 wraps this in the advance loop.

**Execution order inside `executeStep`, which must be preserved exactly:**

1. Resolve the step definition and instantiate the step from the registry.
2. Evaluate `preFlightCheck.conditionsToCheck` if present. Every resolved value must be `true`. On failure apply `actionOnFailure`: `CONTINUE` records a message and proceeds; `SKIP` marks the step `SKIPPED` and returns; `FAIL` throws.
3. Evaluate `stepInputs` into `ctx.inputs` and persist them onto the step row.
4. Call `step.onBeforeRun(ctx)`, then `step.run(ctx)`.
5. Evaluate `stepOutputs` and `stepStateCapture` against the run, merging results into run outputs and run state.
6. Persist.

- [ ] **Step 1: Write the failing test**

`packages/core/test/engine/execute-step.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  BaseStep, PreFlightCheckActionOutcome, RunStepResponse, StepContext,
  WorkflowDefinitionStatus, WorkflowStatus,
} from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { RunExecutor } from "../../src/engine/run-executor";
import { ExpressionEvaluator } from "../../src/expression/evaluator";
import { StepRegistry, registerBuiltInSteps } from "../../src/registry/step-registry";
import { DefinitionRepository } from "../../src/repositories/definition-repository";
import { RunRepository } from "../../src/repositories/run-repository";

jest.setTimeout(120000);

class DelayingStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.status = WorkflowStatus.WAITING;
    return { stepState: ctx.step, delaySeconds: 30 };
  }
}

class ExplodingStep extends BaseStep {
  async run(): Promise<RunStepResponse> {
    throw new Error("step blew up");
  }
}

describe("RunExecutor.executeStep", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let executor: RunExecutor;
  let runs: RunRepository;
  let definitions: DefinitionRepository;
  let evaluator: ExpressionEvaluator;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    registry.register({ type: "test.delaying", version: "1.0.0", factory: (p) => new DelayingStep(p) });
    registry.register({ type: "test.exploding", version: "1.0.0", factory: (p) => new ExplodingStep(p) });

    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    executor = new RunExecutor({ config, db, registry, evaluator });
    runs = new RunRepository(db);
    definitions = new DefinitionRepository(db);
  });

  afterAll(async () => {
    evaluator.dispose();
    await db.close();
    await container.stop();
  });

  async function startRun(name: string, steps: unknown[], inputs = {}): Promise<number> {
    await definitions.create({
      tenantId: "default", name, version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: { steps } as never,
    });
    return executor.startWorkflow({ tenantId: "default", name, version: "1.0.0", inputs });
  }

  it("resolves inputs from expressions and records them on the step", async () => {
    const runId = await startRun("in-1", [
      { stepName: "T", stepVersion: "1.0.0", stepType: "core.transform",
        stepInputs: [{ targetFieldName: "jobId", modelEvaluationExpression: "workflowState.inputs.jobId" }] },
    ], { jobId: "j-7" });

    const run = await runs.findById("default", runId);
    const result = await executor.executeStep(run!, 0);
    expect(result.run.stepRuns![0].inputs).toEqual({ jobId: "j-7" });
    expect(result.run.stepRuns![0].outputs).toEqual({ jobId: "j-7" });
    expect(result.run.stepRuns![0].status).toBe(WorkflowStatus.COMPLETE);
  });

  it("captures step outputs into run state", async () => {
    const runId = await startRun("in-2", [
      { stepName: "T", stepVersion: "1.0.0", stepType: "core.transform",
        stepInputs: [{ targetFieldName: "size", modelEvaluationExpression: "Number(5)" }],
        stepStateCapture: [
          { targetFieldName: "lastSize", modelEvaluationExpression: "workflowState.stepStates.T.outputs.size" },
        ] },
    ]);

    const run = await runs.findById("default", runId);
    const result = await executor.executeStep(run!, 0);
    expect(result.run.state).toEqual({ lastSize: 5 });
  });

  it("skips the step when a pre-flight check fails with SKIP", async () => {
    const runId = await startRun("pf-skip", [
      { stepName: "T", stepVersion: "1.0.0", stepType: "core.transform", stepInputs: [],
        preFlightCheck: {
          conditionsToCheck: [{ targetFieldName: "ok", modelEvaluationExpression: "workflowState.inputs.go === true" }],
          actionOnFailure: PreFlightCheckActionOutcome.SKIP,
        } },
    ], { go: false });

    const run = await runs.findById("default", runId);
    const result = await executor.executeStep(run!, 0);
    expect(result.run.stepRuns![0].status).toBe(WorkflowStatus.SKIPPED);
  });

  it("runs the step anyway when a pre-flight check fails with CONTINUE", async () => {
    const runId = await startRun("pf-continue", [
      { stepName: "T", stepVersion: "1.0.0", stepType: "core.transform", stepInputs: [],
        preFlightCheck: {
          conditionsToCheck: [{ targetFieldName: "ok", modelEvaluationExpression: "false" }],
          actionOnFailure: PreFlightCheckActionOutcome.CONTINUE,
        } },
    ]);

    const run = await runs.findById("default", runId);
    const result = await executor.executeStep(run!, 0);
    expect(result.run.stepRuns![0].status).toBe(WorkflowStatus.COMPLETE);
    expect(result.run.stepRuns![0].message).toMatch(/pre-flight/i);
  });

  it("fails the step when a pre-flight check fails with FAIL", async () => {
    const runId = await startRun("pf-fail", [
      { stepName: "T", stepVersion: "1.0.0", stepType: "core.transform", stepInputs: [],
        preFlightCheck: {
          conditionsToCheck: [{ targetFieldName: "ok", modelEvaluationExpression: "false" }],
          actionOnFailure: PreFlightCheckActionOutcome.FAIL,
          failureMessage: "inputs not ready",
        } },
    ]);

    const run = await runs.findById("default", runId);
    await expect(executor.executeStep(run!, 0)).rejects.toThrow(/inputs not ready/);
    const reloaded = await runs.findById("default", runId);
    expect(reloaded!.stepRuns![0].status).toBe(WorkflowStatus.FAILED);
  });

  it("returns delaySeconds and leaves the step WAITING", async () => {
    const runId = await startRun("delayed", [
      { stepName: "D", stepVersion: "1.0.0", stepType: "test.delaying", stepInputs: [] },
    ]);

    const run = await runs.findById("default", runId);
    const result = await executor.executeStep(run!, 0);
    expect(result.delaySeconds).toBe(30);
    expect(result.run.stepRuns![0].status).toBe(WorkflowStatus.WAITING);
  });

  it("marks the step FAILED and persists the error message when a step throws", async () => {
    const runId = await startRun("boom", [
      { stepName: "B", stepVersion: "1.0.0", stepType: "test.exploding", stepInputs: [] },
    ]);

    const run = await runs.findById("default", runId);
    await expect(executor.executeStep(run!, 0)).rejects.toThrow(/step blew up/);
    const reloaded = await runs.findById("default", runId);
    expect(reloaded!.stepRuns![0].status).toBe(WorkflowStatus.FAILED);
    expect(reloaded!.stepRuns![0].message).toMatch(/step blew up/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- execute-step`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/engine/run-executor.ts`:

```typescript
import {
  PreFlightCheckActionOutcome, StepContext, StepDefinition, WorkflowStatus, resolveStepType,
} from "@wfe/sdk";
import { pick } from "lodash";
import { StepRun } from "../entities/step-run";
import { WorkflowRun } from "../entities/workflow-run";
import { WfeError } from "../errors";
import { captureParameters } from "../expression/capture";
import { WorkflowManager } from "./workflow-manager";

export interface ExecuteStepResult {
  run: WorkflowRun;
  delaySeconds?: number;
}

export class RunExecutor extends WorkflowManager {
  /** Only the allowlisted config keys are ever visible to an expression. */
  protected expressionConfig(): Record<string, unknown> {
    return pick(this.config as Record<string, unknown>, this.config.expressionConfigKeys ?? []);
  }

  protected async definitionStepsFor(run: WorkflowRun): Promise<StepDefinition[]> {
    const definition = await this.lookupDefinition({
      tenantId: run.tenantId, name: run.name, version: run.version,
      inputs: {}, definitionId: run.definitionId,
    });
    return definition.definition.steps;
  }

  async executeStep(run: WorkflowRun, stepNumber: number, body?: unknown): Promise<ExecuteStepResult> {
    const steps = await this.definitionStepsFor(run);
    const stepDefinition = steps[stepNumber];
    if (!stepDefinition) {
      throw new WfeError(`Run ${run.id} has no step at index ${stepNumber}`, {
        statusCode: 400, code: "STEP_INDEX_OUT_OF_RANGE",
      });
    }

    const stepRun = run.stepRuns![stepNumber] as StepRun;
    const step = this.registry.create(resolveStepType(stepDefinition), {
      name: stepDefinition.stepName,
      version: stepDefinition.stepVersion,
      type: resolveStepType(stepDefinition),
    });

    const config = this.expressionConfig();
    stepRun.lastStepAction = new Date();
    stepRun.status = WorkflowStatus.RUNNING;

    try {
      // 1. Declarative pre-flight check.
      if (stepDefinition.preFlightCheck) {
        const { conditionsToCheck, actionOnFailure, failureMessage } = stepDefinition.preFlightCheck;
        const conditions = await captureParameters({
          evaluator: this.evaluator, run, expressions: conditionsToCheck, config, body,
        });
        const allTrue = Object.values(conditions).every((value) => value === true);

        if (!allTrue) {
          const message = failureMessage ?? `Pre-flight check failed for step ${stepDefinition.stepName}`;
          if (actionOnFailure === PreFlightCheckActionOutcome.FAIL) {
            throw new WfeError(message, { statusCode: 400, code: "PREFLIGHT_FAILED" });
          }
          if (actionOnFailure === PreFlightCheckActionOutcome.SKIP) {
            stepRun.status = WorkflowStatus.SKIPPED;
            stepRun.message = message;
            await this.runs.save(run);
            return { run };
          }
          stepRun.message = message; // CONTINUE
        }
      }

      // 2. Resolve inputs.
      const inputs = await captureParameters({
        evaluator: this.evaluator, run, expressions: stepDefinition.stepInputs, config, body,
      });
      stepRun.inputs = inputs;

      // 3. Run.
      const ctx: StepContext = {
        config, logger: this.log, services: this.services,
        run, step: stepRun, stepNumber, inputs, body,
      };
      await step.onBeforeRun(ctx);
      const response = await step.run(ctx);

      // 4. Capture outputs and state from the post-run run snapshot.
      if (stepDefinition.stepOutputs?.length) {
        const outputs = await captureParameters({
          evaluator: this.evaluator, run, expressions: stepDefinition.stepOutputs, config, body,
        });
        run.outputs = { ...run.outputs, ...outputs };
      }
      if (stepDefinition.stepStateCapture?.length) {
        const state = await captureParameters({
          evaluator: this.evaluator, run, expressions: stepDefinition.stepStateCapture, config, body,
        });
        run.state = { ...run.state, ...state };
      }

      const saved = await this.runs.save(run);
      return { run: saved, delaySeconds: response.delaySeconds };
    } catch (err) {
      stepRun.status = WorkflowStatus.FAILED;
      stepRun.message = (err as Error).message;
      run.status = WorkflowStatus.FAILED;
      await this.runs.save(run);
      this.log.error("Step execution failed", {
        runId: run.id, stepNumber, stepName: stepDefinition.stepName, error: (err as Error).message,
      });
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -w @wfe/core -- execute-step`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): execute a single workflow step with pre-flight, capture and error handling"
```

---

### Task 12: Advance loop and resume guards

**Files:**
- Modify: `packages/core/src/engine/run-executor.ts`
- Test: `packages/core/test/engine/run-loop.test.ts`

**Interfaces:**
- Consumes: `executeStep` (Task 11), `isResumeBlocked` (Task 2).
- Produces: `RunExecutor.run(tenantId: string, runId: number, stepNumber: number, body?: unknown): Promise<WorkflowRun>` and `RunExecutor.start(tenantId: string, runId: number): Promise<WorkflowRun>`. Plan 2's queue listeners call `run`.

**Design note — the guards are the correctness core.** Queue delivery in Plan 2 is at-least-once, so `run` will be called with stale messages. Ported verbatim from the source `work-delay-listener`: discard, do not execute, when the run does not exist, when `run.currentStep !== stepNumber`, or when `isResumeBlocked(run.status)`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/engine/run-loop.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  BaseStep, RunStepResponse, StepContext, WorkflowDefinitionStatus, WorkflowStatus,
} from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { RunExecutor } from "../../src/engine/run-executor";
import { ExpressionEvaluator } from "../../src/expression/evaluator";
import { StepRegistry, registerBuiltInSteps } from "../../src/registry/step-registry";
import { DefinitionRepository } from "../../src/repositories/definition-repository";
import { RunRepository } from "../../src/repositories/run-repository";

jest.setTimeout(120000);

let runCount = 0;

class CountingStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    runCount += 1;
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

class WaitingStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.status = WorkflowStatus.WAITING;
    return { stepState: ctx.step, delaySeconds: 60 };
  }
}

describe("RunExecutor.run", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let executor: RunExecutor;
  let runs: RunRepository;
  let definitions: DefinitionRepository;
  let evaluator: ExpressionEvaluator;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    registry.register({ type: "test.counting", version: "1.0.0", factory: (p) => new CountingStep(p) });
    registry.register({ type: "test.waiting", version: "1.0.0", factory: (p) => new WaitingStep(p) });

    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    executor = new RunExecutor({ config, db, registry, evaluator });
    runs = new RunRepository(db);
    definitions = new DefinitionRepository(db);
  });

  afterAll(async () => {
    evaluator.dispose();
    await db.close();
    await container.stop();
  });

  beforeEach(() => { runCount = 0; });

  function threeSteps(type: string) {
    return ["One", "Two", "Three"].map((stepName) => ({
      stepName, stepVersion: "1.0.0", stepType: type, stepInputs: [],
    }));
  }

  async function startRun(name: string, steps: unknown[]): Promise<number> {
    await definitions.create({
      tenantId: "default", name, version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED, definition: { steps } as never,
    });
    return executor.startWorkflow({ tenantId: "default", name, version: "1.0.0", inputs: {} });
  }

  it("runs every step and completes the run", async () => {
    const runId = await startRun("loop-1", threeSteps("test.counting"));
    const run = await executor.start("default", runId);
    expect(runCount).toBe(3);
    expect(run.status).toBe(WorkflowStatus.COMPLETE);
    expect(run.currentStep).toBe(2);
    expect(run.stepRuns!.every((s) => s.status === WorkflowStatus.COMPLETE)).toBe(true);
  });

  it("suspends at a delaying step and leaves the run WAITING", async () => {
    const runId = await startRun("loop-2", [
      { stepName: "One", stepVersion: "1.0.0", stepType: "test.counting", stepInputs: [] },
      { stepName: "Two", stepVersion: "1.0.0", stepType: "test.waiting", stepInputs: [] },
      { stepName: "Three", stepVersion: "1.0.0", stepType: "test.counting", stepInputs: [] },
    ]);
    const run = await executor.start("default", runId);
    expect(runCount).toBe(1);
    expect(run.status).toBe(WorkflowStatus.WAITING);
    expect(run.currentStep).toBe(1);
  });

  it("discards a resume message whose step number is stale", async () => {
    const runId = await startRun("loop-3", threeSteps("test.counting"));
    await executor.start("default", runId);
    runCount = 0;
    await executor.run("default", runId, 0);
    expect(runCount).toBe(0);
  });

  it("discards a resume message for a cancelled run", async () => {
    const runId = await startRun("loop-4", threeSteps("test.waiting"));
    await executor.start("default", runId);
    await executor.cancel("default", runId);
    runCount = 0;
    await executor.run("default", runId, 0);
    expect(runCount).toBe(0);
  });

  it("throws for a run that does not exist", async () => {
    await expect(executor.run("default", 999999, 0)).rejects.toThrow(/999999/);
  });

  it("restarts from an earlier step, resetting it and its successors", async () => {
    const runId = await startRun("loop-5", threeSteps("test.counting"));
    await executor.start("default", runId);
    runCount = 0;
    const run = await executor.restartFromStep("default", runId, 1);
    expect(runCount).toBe(2);
    expect(run.status).toBe(WorkflowStatus.COMPLETE);
  });

  it("marks a cancelled run CANCELLED and stops advancing it", async () => {
    const runId = await startRun("loop-6", threeSteps("test.waiting"));
    await executor.start("default", runId);
    const cancelled = await executor.cancel("default", runId);
    expect(cancelled.status).toBe(WorkflowStatus.CANCELLED);
    const reloaded = await runs.findById("default", runId);
    expect(reloaded!.status).toBe(WorkflowStatus.CANCELLED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- run-loop`
Expected: FAIL — `executor.start is not a function`.

- [ ] **Step 3: Add the loop, guards, cancel and restart**

Append to `packages/core/src/engine/run-executor.ts` (inside the `RunExecutor` class), and add `isResumeBlocked` to the `@wfe/sdk` import:

```typescript
  /** Begins execution of a freshly created run at step 0. */
  async start(tenantId: string, runId: number): Promise<WorkflowRun> {
    return this.run(tenantId, runId, 0);
  }

  /**
   * Advances a run from `stepNumber` until it completes, fails, or suspends.
   *
   * Queue delivery is at-least-once, so this is called with stale messages. The
   * guards below discard those instead of re-running work.
   */
  async run(tenantId: string, runId: number, stepNumber: number, body?: unknown): Promise<WorkflowRun> {
    let run = await this.runs.findById(tenantId, runId);
    if (!run) {
      throw new WfeError(`Cannot locate workflow run ${runId}`, {
        statusCode: 404, code: "RUN_NOT_FOUND",
      });
    }

    if (isResumeBlocked(run.status)) {
      this.log.warn("Discarding resume for a run in a blocked state", {
        runId, stepNumber, status: run.status,
      });
      return run;
    }

    // -1 means "not started"; any other mismatch is a stale message.
    if (run.currentStep !== -1 && run.currentStep !== stepNumber) {
      this.log.warn("Discarding resume for a stale step number", {
        runId, stepNumber, currentStep: run.currentStep,
      });
      return run;
    }

    const steps = await this.definitionStepsFor(run);
    let nextStep = stepNumber;
    let payload = body;

    while (nextStep < steps.length) {
      run.currentStep = nextStep;
      run.status = WorkflowStatus.RUNNING;
      run = await this.runs.save(run);

      const result = await this.executeStep(run, nextStep, payload);
      run = result.run;
      payload = undefined; // a callback payload applies only to the step it resumed

      if (result.delaySeconds !== undefined) {
        run.status = WorkflowStatus.WAITING;
        return this.runs.save(run);
      }

      nextStep += 1;
    }

    run.currentStep = steps.length - 1;
    run.status = WorkflowStatus.COMPLETE;
    return this.runs.save(run);
  }

  /** Marks a run cancelled. In-flight steps are not interrupted. */
  async cancel(tenantId: string, runId: number): Promise<WorkflowRun> {
    const run = await this.runs.findById(tenantId, runId);
    if (!run) {
      throw new WfeError(`Cannot locate workflow run ${runId}`, {
        statusCode: 404, code: "RUN_NOT_FOUND",
      });
    }
    run.status = WorkflowStatus.CANCELLED;
    this.log.info("Cancelled workflow run", { runId, tenantId });
    return this.runs.save(run);
  }

  /** Resets the given step and everything after it, then runs from there. */
  async restartFromStep(tenantId: string, runId: number, stepNumber: number): Promise<WorkflowRun> {
    const run = await this.runs.findById(tenantId, runId);
    if (!run) {
      throw new WfeError(`Cannot locate workflow run ${runId}`, {
        statusCode: 404, code: "RUN_NOT_FOUND",
      });
    }

    for (const step of run.stepRuns ?? []) {
      if (step.stepNumber >= stepNumber) {
        step.status = WorkflowStatus.NEW;
        step.message = undefined;
        step.outputs = {};
        step.state = {};
      }
    }
    run.currentStep = stepNumber;
    run.status = WorkflowStatus.RUNNING;
    await this.runs.save(run);

    return this.run(tenantId, runId, stepNumber);
  }
```

- [ ] **Step 4: Run tests**

Run: `npm test -w @wfe/core -- run-loop`
Expected: PASS — 7 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — every test across both packages.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add run advance loop, resume guards, cancel and restart"
```

---

### Task 13: End-to-end example and quickstart

**Files:**
- Create: `examples/definitions/three-step.json`, `examples/run-example.ts`
- Create: `packages/core/src/index.ts` (replace the placeholder with real exports)
- Create: `README.md`
- Test: `packages/core/test/engine/example-definition.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: `@wfe/core` public exports — `WorkflowManager`, `RunExecutor`, `StepRegistry`, `registerBuiltInSteps`, `ExpressionEvaluator`, `DbContext`, `loadEngineConfig`, `WfeError`, entities, repositories, `validateDefinitionShape`, `validateAgainstRegistry`. Plan 2 and Plan 3 import from here.

- [ ] **Step 1: Write the example definition**

`examples/definitions/three-step.json`:

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
      },
      {
        "stepName": "Check",
        "stepVersion": "1.0.0",
        "stepType": "core.transform",
        "stepInputs": [
          { "targetFieldName": "label", "modelEvaluationExpression": "String(\"checked\")" },
          { "targetFieldName": "attempt", "modelEvaluationExpression": "workflowState.stepStates.Prepare.outputs.attempt + 1" }
        ],
        "preFlightCheck": {
          "conditionsToCheck": [
            { "targetFieldName": "hasJob", "modelEvaluationExpression": "workflowState.state.jobId !== undefined" }
          ],
          "actionOnFailure": "skip"
        }
      },
      {
        "stepName": "Finish",
        "stepVersion": "1.0.0",
        "stepType": "core.noop",
        "stepInputs": [],
        "stepOutputs": [
          { "targetFieldName": "finalLabel", "modelEvaluationExpression": "workflowState.stepStates.Check.outputs.label" },
          { "targetFieldName": "attempts", "modelEvaluationExpression": "workflowState.stepStates.Check.outputs.attempt" }
        ]
      }
    ]
  }
}
```

This exercises literal constructors, cross-step references by name, state capture, a pre-flight check and run-level output capture — the whole Phase 1 surface in one file.

- [ ] **Step 2: Write the failing test**

`packages/core/test/engine/example-definition.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DbContext, ExpressionEvaluator, RunExecutor, StepRegistry, registerBuiltInSteps,
  DefinitionRepository, validateDefinitionShape,
} from "../../src";

jest.setTimeout(120000);

describe("three-step example definition", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let executor: RunExecutor;
  let evaluator: ExpressionEvaluator;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    executor = new RunExecutor({ config, db, registry, evaluator });

    const raw = JSON.parse(
      readFileSync(join(__dirname, "../../../../examples/definitions/three-step.json"), "utf8")
    );
    const body = await validateDefinitionShape(raw.definition);
    await new DefinitionRepository(db).create({
      tenantId: "default", name: raw.workflowName, version: raw.workflowVersion,
      definition: body, status: WorkflowDefinitionStatus.PUBLISHED,
    });
  });

  afterAll(async () => {
    evaluator.dispose();
    await db.close();
    await container.stop();
  });

  it("runs end to end and captures outputs across steps", async () => {
    const runId = await executor.startWorkflow({
      tenantId: "default", name: "three-step", version: "1.0.0", inputs: { jobId: "job-42" },
    });
    const run = await executor.start("default", runId);

    expect(run.status).toBe(WorkflowStatus.COMPLETE);
    expect(run.state).toEqual({ jobId: "job-42" });
    expect(run.outputs).toEqual({ finalLabel: "checked", attempts: 2 });
    expect(run.stepRuns!.map((s) => s.status)).toEqual([
      WorkflowStatus.COMPLETE, WorkflowStatus.COMPLETE, WorkflowStatus.COMPLETE,
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @wfe/core -- example-definition`
Expected: FAIL — the exports do not exist in `src/index.ts`.

- [ ] **Step 4: Write the public exports**

`packages/core/src/index.ts`:

```typescript
export * from "./config";
export * from "./errors";
export * from "./logging";
export * from "./expression/evaluator";
export * from "./expression/capture";
export * from "./expression/snapshot";
export * from "./entities/progress";
export * from "./entities/workflow-definition";
export * from "./entities/workflow-run";
export * from "./entities/step-run";
export * from "./db/db-context";
export * from "./repositories/definition-repository";
export * from "./repositories/run-repository";
export * from "./registry/step-registry";
export * from "./registry/validate";
export * from "./steps/noop-step";
export * from "./steps/transform-step";
export * from "./engine/workflow-manager";
export * from "./engine/run-executor";
```

- [ ] **Step 5: Run tests**

Run: `npm test -w @wfe/core -- example-definition`
Expected: PASS — 1 test.

- [ ] **Step 6: Write the runnable example script**

`examples/run-example.ts`:

```typescript
import "reflect-metadata";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DbContext, DefinitionRepository, ExpressionEvaluator, RunExecutor,
  StepRegistry, loadEngineConfig, registerBuiltInSteps, validateDefinitionShape,
} from "@wfe/core";
import { WorkflowDefinitionStatus } from "@wfe/sdk";

async function main(): Promise<void> {
  const config = loadEngineConfig();
  const db = new DbContext(config);
  await db.runMigrations();

  const registry = new StepRegistry();
  registerBuiltInSteps(registry);
  const evaluator = new ExpressionEvaluator({ timeoutMs: config.expressionTimeoutMs });
  const executor = new RunExecutor({ config, db, registry, evaluator });

  const raw = JSON.parse(readFileSync(join(__dirname, "definitions/three-step.json"), "utf8"));
  const definition = await validateDefinitionShape(raw.definition);
  await new DefinitionRepository(db).create({
    tenantId: "default", name: raw.workflowName, version: raw.workflowVersion,
    definition, status: WorkflowDefinitionStatus.PUBLISHED,
  });

  const runId = await executor.startWorkflow({
    tenantId: "default", name: raw.workflowName, version: raw.workflowVersion,
    inputs: { jobId: "job-42" },
  });
  const run = await executor.start("default", runId);

  console.log(JSON.stringify({
    runId: run.id, status: run.status, outputs: run.outputs, state: run.state,
    steps: run.stepRuns?.map((s) => ({ n: s.stepNumber, name: s.stepName, status: s.status })),
  }, null, 2));

  evaluator.dispose();
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Write the README quickstart**

`README.md`:

````markdown
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
npx ts-node examples/run-example.ts
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
````

- [ ] **Step 8: Verify the example runs against a real database**

```bash
docker run --rm -d --name wfe-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=wfe postgres:16-alpine
export WFE_DB_URL=postgres://postgres:postgres@localhost:5432/wfe
npx ts-node examples/run-example.ts
docker rm -f wfe-pg
```

Expected: JSON output with `"status": "complete"` and `"outputs": { "finalLabel": "checked", "attempts": 2 }`.

- [ ] **Step 9: Run the full suite and build**

Run: `npm run build && npm test`
Expected: both green.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add end-to-end example workflow, public exports and quickstart"
```

---

## Out of scope for this plan

Deliberately deferred, each to its own plan:

- **Plan 2 — Queues:** `QueueDriver` interface, `sqs` and `rabbitmq` drivers, delay-queue resumption, worker-response and external-service queues, long-delay chaining.
- **Plan 3 — Server:** REST surface per spec §10, OpenAPI, `AuthProvider` (`none`), filter/search, `wfe` CLI, Dockerfile, docker-compose.
- **Plan 4 — Plugins and steps:** plugin loader, `core.http`, `core.condition`, `core.subWorkflow`, `core.emitEvent`, `core.externalTask`, example plugin package, `step_blob` and `batch_job_record` entities and migration.
- **Plan 5 — UI:** the five screens.
- **Plan 6 — Release:** docs, publishing.
