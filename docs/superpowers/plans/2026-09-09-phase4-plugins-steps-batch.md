# Phase 4: Plugin Loader, Built-in Steps, Batch Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the engine from a framework into a product by adding plugin loading, four built-in steps, definition snapshotting, batch jobs, and carry-forward fixes.

**Architecture:** Plugin loader reads `WFE_PLUGINS` specifiers and calls each module's default export with the `StepRegistry`. Four new steps (`core.http`, `core.condition`, `core.subWorkflow`, `core.emitEvent`) are added to `@wfe/core`. Definition snapshotting freezes the definition body onto the run at creation. Batch jobs fan out one definition over N input records with progress computed on read. All new entity/migration work lands in `@wfe/core`; HTTP routes in `@wfe/server`.

**Tech Stack:** TypeScript 5.9, Node 24 built-in `fetch`, TypeORM, Express, isolated-vm, jest + testcontainers.

**Spec:** `docs/superpowers/specs/2026-09-09-phase4-plugins-steps-batch-design.md`

## Global Constraints

- Node `^24.0.0`; npm `>=11`. TypeScript `^5.9.3`, `module: commonjs`.
- No `@mast/*` dependency anywhere.
- `npm run build` before `npm test` — the only authoritative result.
- TDD: write the failing test, watch it fail, implement, watch it pass, commit.
- Every task gets its own commit with a conventional-commit message.

---

### Task 1: Plugin loader + sample plugin

**Files:**
- Create: `packages/core/src/registry/plugin-loader.ts`
- Create: `packages/core/test/registry/plugin-loader.test.ts`
- Create: `examples/sample-plugin/package.json`
- Create: `examples/sample-plugin/index.ts`
- Create: `examples/sample-plugin/tsconfig.json`
- Modify: `packages/core/src/index.ts` — add export for `plugin-loader`

**Interfaces:**
- Consumes: `StepRegistry` from `packages/core/src/registry/step-registry.ts` — `register(registration: StepRegistration): void`, `has(type: string): boolean`
- Produces: `loadPlugins(specifiers: string[], registry: StepRegistry, logger?: Logger): Promise<void>` — used by Tasks 7 (CLI integration) and by any future boot path.

- [ ] **Step 1: Write the failing test for loadPlugins**

Create `packages/core/test/registry/plugin-loader.test.ts`:

```typescript
import "reflect-metadata";
import { StepRegistry } from "../../src/registry/step-registry";
import { loadPlugins } from "../../src/registry/plugin-loader";

describe("loadPlugins", () => {
  it("loads a plugin module and registers its step types", async () => {
    const registry = new StepRegistry();
    const pluginPath = require.resolve("../../../examples/sample-plugin");
    await loadPlugins([pluginPath], registry);
    expect(registry.has("sample.echo")).toBe(true);
  });

  it("throws PLUGIN_INVALID for a module with no callable export", async () => {
    const registry = new StepRegistry();
    // JSON files have no default function export
    const jsonPath = require.resolve("../../../package.json");
    await expect(loadPlugins([jsonPath], registry)).rejects.toMatchObject({
      code: "PLUGIN_INVALID",
    });
  });

  it("throws PLUGIN_LOAD_FAILED for a non-existent module", async () => {
    const registry = new StepRegistry();
    await expect(loadPlugins(["./does-not-exist-xyz"], registry)).rejects.toMatchObject({
      code: "PLUGIN_LOAD_FAILED",
    });
  });
});
```

- [ ] **Step 2: Create the sample plugin**

Create `examples/sample-plugin/package.json`:

```json
{
  "name": "wfe-sample-plugin",
  "version": "1.0.0",
  "main": "index.ts",
  "private": true
}
```

Create `examples/sample-plugin/index.ts`:

```typescript
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

class EchoStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.outputs = { ...ctx.inputs };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

export default function register(registry: import("@wfe/core").StepRegistry): void {
  registry.register({
    type: "sample.echo",
    version: "1.0.0",
    description: "Echoes its resolved inputs to outputs. Demo plugin.",
    factory: (params) => new EchoStep(params),
  });
}
```

Create `examples/sample-plugin/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "declaration": false, "sourceMap": false },
  "include": ["index.ts"]
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/core && npx jest test/registry/plugin-loader.test.ts --verbose`
Expected: FAIL — `Cannot find module '../../src/registry/plugin-loader'`

- [ ] **Step 4: Implement loadPlugins**

Create `packages/core/src/registry/plugin-loader.ts`:

```typescript
import { Logger } from "@wfe/sdk";
import { WfeError } from "../errors";
import { createLogger } from "../logging";
import { StepRegistry } from "./step-registry";

export async function loadPlugins(
  specifiers: string[],
  registry: StepRegistry,
  logger?: Logger,
): Promise<void> {
  const log = logger ?? createLogger("plugin-loader");

  for (const spec of specifiers) {
    log.info("Loading plugin", { specifier: spec });
    let mod: Record<string, unknown>;
    try {
      mod = await import(spec);
    } catch (err) {
      throw new WfeError(`Failed to load plugin "${spec}": ${(err as Error).message}`, {
        statusCode: 500,
        code: "PLUGIN_LOAD_FAILED",
        cause: err as Error,
      });
    }

    const register = (mod.default ?? mod) as unknown;
    if (typeof register !== "function") {
      throw new WfeError(
        `Plugin "${spec}" has no callable default export (got ${typeof register})`,
        { statusCode: 500, code: "PLUGIN_INVALID" },
      );
    }

    const result = register(registry);
    if (result && typeof (result as Promise<void>).then === "function") {
      await result;
    }

    log.info("Plugin loaded", { specifier: spec, registeredTypes: registry.list().map((r) => r.type) });
  }
}
```

Add to `packages/core/src/index.ts`:

```typescript
export * from "./registry/plugin-loader";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && cd packages/core && npx jest test/registry/plugin-loader.test.ts --verbose`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): add plugin loader and sample plugin"
```

---

### Task 2: StepContext additions + delay NaN guard + condition and emitEvent steps

**Files:**
- Modify: `packages/sdk/src/step-context.ts` — add `queue`, `startChildWorkflow`
- Modify: `packages/core/src/steps/delay-step.ts` — add NaN guard
- Create: `packages/core/src/steps/condition-step.ts`
- Create: `packages/core/src/steps/emit-event-step.ts`
- Modify: `packages/core/src/registry/step-registry.ts` — register new steps
- Modify: `packages/core/src/index.ts` — export new steps
- Create: `packages/core/test/steps/condition-step.test.ts`
- Create: `packages/core/test/steps/emit-event-step.test.ts`
- Modify: existing delay-step tests to cover NaN guard

**Interfaces:**
- Consumes: `StepContext` from `@wfe/sdk`, `WfeError` from `@wfe/core`
- Produces:
  - Updated `StepContext` with `queue?: { publish(queue: string, msg: unknown): Promise<void> }` and `startChildWorkflow?: (input: { name: string; version: string; inputs: WorkflowParameters }) => Promise<number>`
  - `ConditionStep` class — registered as `core.condition`
  - `EmitEventStep` class — registered as `core.emitEvent`
  - `DelayStep` with NaN guard (throws `WfeError` with code `DELAY_INVALID_SECONDS`)

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/steps/condition-step.test.ts`:

```typescript
import "reflect-metadata";
import { WorkflowStatus } from "@wfe/sdk";
import { ConditionStep } from "../../src/steps/condition-step";

function makeCtx(inputs: Record<string, unknown>) {
  const step: any = { status: WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} };
  return {
    config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    services: {}, run: {} as any, step, stepNumber: 0,
    inputs, isResume: false,
  };
}

describe("ConditionStep", () => {
  const condStep = new ConditionStep({ name: "C", version: "1.0.0", type: "core.condition" });

  it("completes when condition is truthy", async () => {
    const ctx = makeCtx({ condition: true });
    const result = await condStep.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
  });

  it("marks SKIPPED when condition is falsy and action is skip", async () => {
    const ctx = makeCtx({ condition: false, action: "skip" });
    const result = await condStep.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.SKIPPED);
  });

  it("marks SKIPPED when condition is falsy and action is omitted (default)", async () => {
    const ctx = makeCtx({ condition: false });
    const result = await condStep.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.SKIPPED);
  });

  it("throws when condition is falsy and action is fail", async () => {
    const ctx = makeCtx({ condition: false, action: "fail", message: "not ready" });
    await expect(condStep.run(ctx as any)).rejects.toMatchObject({
      code: "CONDITION_FAILED",
    });
  });
});
```

Create `packages/core/test/steps/emit-event-step.test.ts`:

```typescript
import "reflect-metadata";
import { WorkflowStatus } from "@wfe/sdk";
import { EmitEventStep } from "../../src/steps/emit-event-step";

describe("EmitEventStep", () => {
  const step = new EmitEventStep({ name: "E", version: "1.0.0", type: "core.emitEvent" });

  it("publishes to the named queue and completes", async () => {
    const published: Array<{ queue: string; msg: unknown }> = [];
    const ctx: any = {
      config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      services: {}, run: {} as any,
      step: { status: WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} },
      stepNumber: 0, inputs: { queue: "test-queue", payload: { key: "val" } },
      isResume: false,
      queue: { publish: async (q: string, m: unknown) => { published.push({ queue: q, msg: m }); } },
    };
    const result = await step.run(ctx);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
    expect(published).toEqual([{ queue: "test-queue", msg: { key: "val" } }]);
  });

  it("throws QUEUE_NOT_CONFIGURED when no queue is available", async () => {
    const ctx: any = {
      config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      services: {}, run: {} as any,
      step: { status: WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} },
      stepNumber: 0, inputs: { queue: "q", payload: {} },
      isResume: false,
      // no queue
    };
    await expect(step.run(ctx)).rejects.toMatchObject({ code: "QUEUE_NOT_CONFIGURED" });
  });
});
```

Add to an existing or new delay-step test file — create `packages/core/test/steps/delay-step.test.ts`:

```typescript
import "reflect-metadata";
import { WorkflowStatus } from "@wfe/sdk";
import { DelayStep } from "../../src/steps/delay-step";

function makeCtx(inputs: Record<string, unknown>, isResume = false) {
  const step: any = { status: isResume ? WorkflowStatus.WAITING : WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} };
  return {
    config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    services: {}, run: {} as any, step, stepNumber: 0,
    inputs, isResume,
  };
}

describe("DelayStep", () => {
  const delay = new DelayStep({ name: "D", version: "1.0.0", type: "core.delay" });

  it("suspends with delay on first entry", async () => {
    const ctx = makeCtx({ seconds: 30 });
    const result = await delay.run(ctx as any);
    expect(result.suspend).toEqual({ kind: "delay", delaySeconds: 30 });
    expect(result.stepState.status).toBe(WorkflowStatus.WAITING);
  });

  it("completes on resume", async () => {
    const ctx = makeCtx({}, true);
    const result = await delay.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
  });

  it("throws DELAY_INVALID_SECONDS for NaN input", async () => {
    const ctx = makeCtx({ seconds: "not-a-number" });
    await expect(delay.run(ctx as any)).rejects.toMatchObject({
      code: "DELAY_INVALID_SECONDS",
    });
  });

  it("throws DELAY_INVALID_SECONDS for negative input", async () => {
    const ctx = makeCtx({ seconds: -5 });
    await expect(delay.run(ctx as any)).rejects.toMatchObject({
      code: "DELAY_INVALID_SECONDS",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx jest test/steps/ --verbose`
Expected: FAIL — missing modules and unimplemented guard

- [ ] **Step 3: Update StepContext in SDK**

Modify `packages/sdk/src/step-context.ts` — add two new optional fields to `StepContext`:

```typescript
  /** Queue access for steps that publish messages (e.g. core.emitEvent). */
  queue?: {
    publish(queue: string, msg: unknown): Promise<void>;
  };
  /** Starts a child workflow run. Provided by the executor, bound to the current tenantId. */
  startChildWorkflow?: (input: {
    name: string;
    version: string;
    inputs: WorkflowParameters;
  }) => Promise<number>;
```

- [ ] **Step 4: Implement ConditionStep**

Create `packages/core/src/steps/condition-step.ts`:

```typescript
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { WfeError } from "../errors";

export class ConditionStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    const { condition, action, message } = ctx.inputs as {
      condition: unknown;
      action?: string;
      message?: string;
    };

    if (condition) {
      ctx.step.status = WorkflowStatus.COMPLETE;
      return { stepState: ctx.step };
    }

    const effectiveAction = action ?? "skip";
    if (effectiveAction === "fail") {
      throw new WfeError(message ?? "Condition check failed", {
        statusCode: 400,
        code: "CONDITION_FAILED",
      });
    }

    ctx.step.status = WorkflowStatus.SKIPPED;
    ctx.step.message = message ?? "Condition was falsy; step skipped";
    return { stepState: ctx.step };
  }
}
```

- [ ] **Step 5: Implement EmitEventStep**

Create `packages/core/src/steps/emit-event-step.ts`:

```typescript
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { WfeError } from "../errors";

export class EmitEventStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (!ctx.queue) {
      throw new WfeError("core.emitEvent requires a queue driver but none is configured", {
        statusCode: 500,
        code: "QUEUE_NOT_CONFIGURED",
      });
    }

    const { queue, payload } = ctx.inputs as { queue: string; payload: unknown };
    await ctx.queue.publish(queue, payload);

    ctx.step.outputs = { queue, published: true };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
```

- [ ] **Step 6: Add NaN guard to DelayStep**

Modify `packages/core/src/steps/delay-step.ts` — after computing `seconds`, before using it:

```typescript
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { WfeError } from "../errors";

export class DelayStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (ctx.isResume) {
      ctx.step.status = WorkflowStatus.COMPLETE;
      return { stepState: ctx.step };
    }
    const seconds = Number(ctx.inputs.seconds ?? 0);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new WfeError(
        `delay seconds must be a non-negative number, got: ${ctx.inputs.seconds}`,
        { statusCode: 400, code: "DELAY_INVALID_SECONDS" },
      );
    }
    ctx.step.status = WorkflowStatus.WAITING;
    return { stepState: ctx.step, suspend: { kind: "delay", delaySeconds: seconds } };
  }
}
```

- [ ] **Step 7: Register new steps and add exports**

Add to `registerBuiltInSteps` in `packages/core/src/registry/step-registry.ts`:

```typescript
import { ConditionStep } from "../steps/condition-step";
import { EmitEventStep } from "../steps/emit-event-step";

// Inside registerBuiltInSteps():
  registry.register({
    type: "core.condition",
    version: "1.0.0",
    description: "Evaluates a boolean condition; skips or fails when falsy.",
    factory: (params) => new ConditionStep(params),
  });
  registry.register({
    type: "core.emitEvent",
    version: "1.0.0",
    description: "Publishes a payload to a named queue.",
    factory: (params) => new EmitEventStep(params),
  });
```

Add exports to `packages/core/src/index.ts`:

```typescript
export * from "./steps/condition-step";
export * from "./steps/emit-event-step";
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run build && cd packages/core && npx jest test/steps/ --verbose`
Expected: PASS — all condition, emitEvent, and delay tests green

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): add core.condition, core.emitEvent steps, delay NaN guard, StepContext queue/startChildWorkflow"
```

---

### Task 3: core.http step

**Files:**
- Create: `packages/core/src/steps/http-step.ts`
- Create: `packages/core/test/steps/http-step.test.ts`
- Modify: `packages/core/src/registry/step-registry.ts` — register `core.http`
- Modify: `packages/core/src/index.ts` — export

**Interfaces:**
- Consumes: `BaseStep`, `StepContext`, `WorkflowStatus` from `@wfe/sdk`; `WfeError` from `@wfe/core`
- Produces: `HttpStep` class — registered as `core.http`. Inputs: `{ url, method?, headers?, body?, retries?, backoffMs?, timeoutMs? }`. Outputs: `{ status, headers, body }`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/steps/http-step.test.ts`:

```typescript
import "reflect-metadata";
import { createServer, Server } from "http";
import { WorkflowStatus } from "@wfe/sdk";
import { HttpStep } from "../../src/steps/http-step";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ greeting: "hello" }));
    } else if (req.url === "/fail-then-ok") {
      // Fails first time, succeeds second
      const count = Number(req.headers["x-attempt"] ?? "1");
      if (count <= 1) {
        res.writeHead(500);
        res.end("server error");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ retried: true }));
      }
    } else if (req.url === "/post-echo") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    } else if (req.url === "/slow") {
      // Never responds — tests timeout
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => { server.close(); });

function makeCtx(inputs: Record<string, unknown>) {
  const step: any = { status: WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} };
  return {
    config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    services: {}, run: {} as any, step, stepNumber: 0,
    inputs, isResume: false,
  };
}

describe("HttpStep", () => {
  const httpStep = new HttpStep({ name: "H", version: "1.0.0", type: "core.http" });

  it("makes a GET request and captures the response", async () => {
    const ctx = makeCtx({ url: `${baseUrl}/ok` });
    const result = await httpStep.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
    expect(result.stepState.outputs).toMatchObject({
      status: 200,
      body: { greeting: "hello" },
    });
  });

  it("makes a POST request with a JSON body", async () => {
    const ctx = makeCtx({
      url: `${baseUrl}/post-echo`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { key: "value" },
    });
    const result = await httpStep.run(ctx as any);
    expect(result.stepState.outputs.body).toEqual({ key: "value" });
  });

  it("fails on non-2xx after exhausting retries", async () => {
    const ctx = makeCtx({ url: `${baseUrl}/not-a-page`, retries: 0 });
    await expect(httpStep.run(ctx as any)).rejects.toMatchObject({
      code: "HTTP_STEP_FAILED",
    });
  });

  it("times out on a slow response", async () => {
    const ctx = makeCtx({ url: `${baseUrl}/slow`, timeoutMs: 200 });
    await expect(httpStep.run(ctx as any)).rejects.toMatchObject({
      code: "HTTP_STEP_FAILED",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx jest test/steps/http-step.test.ts --verbose`
Expected: FAIL — `Cannot find module '../../src/steps/http-step'`

- [ ] **Step 3: Implement HttpStep**

Create `packages/core/src/steps/http-step.ts`:

```typescript
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { WfeError } from "../errors";

export class HttpStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    const {
      url,
      method = "GET",
      headers = {},
      body,
      retries = 0,
      backoffMs = 1000,
      timeoutMs = 30000,
    } = ctx.inputs as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      retries?: number;
      backoffMs?: number;
      timeoutMs?: number;
    };

    if (!url) {
      throw new WfeError("core.http requires a url input", {
        statusCode: 400,
        code: "HTTP_STEP_MISSING_URL",
      });
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const fetchHeaders: Record<string, string> = { ...headers };
        if (attempt > 0) {
          fetchHeaders["x-attempt"] = String(attempt + 1);
        }

        const fetchOptions: RequestInit = {
          method: method.toUpperCase(),
          headers: fetchHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        };

        if (body !== undefined && method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") {
          fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
          if (!fetchHeaders["content-type"]) {
            fetchHeaders["content-type"] = "application/json";
          }
        }

        const response = await fetch(url, fetchOptions);

        if (response.ok) {
          let responseBody: unknown;
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            responseBody = await response.json();
          } else {
            responseBody = await response.text();
          }

          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((v, k) => { responseHeaders[k] = v; });

          ctx.step.outputs = { status: response.status, headers: responseHeaders, body: responseBody };
          ctx.step.status = WorkflowStatus.COMPLETE;
          return { stepState: ctx.step };
        }

        lastError = new Error(`HTTP ${response.status}: ${await response.text()}`);
      } catch (err) {
        lastError = err as Error;
      }
    }

    throw new WfeError(
      `core.http request to ${url} failed after ${retries + 1} attempt(s): ${lastError?.message}`,
      { statusCode: 502, code: "HTTP_STEP_FAILED", cause: lastError },
    );
  }
}
```

Register in `packages/core/src/registry/step-registry.ts` inside `registerBuiltInSteps`:

```typescript
import { HttpStep } from "../steps/http-step";

  registry.register({
    type: "core.http",
    version: "1.0.0",
    description: "Makes an HTTP request with optional retry/backoff.",
    factory: (params) => new HttpStep(params),
  });
```

Add export to `packages/core/src/index.ts`:

```typescript
export * from "./steps/http-step";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && cd packages/core && npx jest test/steps/http-step.test.ts --verbose`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add core.http step with retry/backoff and timeout"
```

---

### Task 4: core.subWorkflow step + executor context wiring

**Files:**
- Create: `packages/core/src/steps/sub-workflow-step.ts`
- Create: `packages/core/test/steps/sub-workflow-step.test.ts`
- Modify: `packages/core/src/engine/run-executor.ts` — wire `queue` and `startChildWorkflow` into `StepContext`
- Modify: `packages/core/src/registry/step-registry.ts` — register `core.subWorkflow`
- Modify: `packages/core/src/index.ts` — export

**Interfaces:**
- Consumes: `StepContext` (updated in Task 2) from `@wfe/sdk`; `WorkflowManager.startWorkflow` signature: `startWorkflow(input: StartWorkflowInput): Promise<number>`; `RunExecutor` from `@wfe/core`
- Produces: `SubWorkflowStep` class — registered as `core.subWorkflow`. Inputs: `{ name, version, inputs }`. Outputs: `{ childRunId }`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/steps/sub-workflow-step.test.ts`:

```typescript
import "reflect-metadata";
import { WorkflowStatus } from "@wfe/sdk";
import { SubWorkflowStep } from "../../src/steps/sub-workflow-step";

function makeCtx(inputs: Record<string, unknown>, startChildWorkflow?: Function) {
  const step: any = { status: WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} };
  return {
    config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    services: {}, run: { tenantId: "default" } as any, step, stepNumber: 0,
    inputs, isResume: false,
    startChildWorkflow,
  };
}

describe("SubWorkflowStep", () => {
  const subStep = new SubWorkflowStep({ name: "S", version: "1.0.0", type: "core.subWorkflow" });

  it("starts a child workflow and records the runId in outputs", async () => {
    const starter = jest.fn().mockResolvedValue(42);
    const ctx = makeCtx({ name: "child-wf", version: "1.0.0", inputs: { a: 1 } }, starter);
    const result = await subStep.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
    expect(result.stepState.outputs).toEqual({ childRunId: 42 });
    expect(starter).toHaveBeenCalledWith({ name: "child-wf", version: "1.0.0", inputs: { a: 1 } });
  });

  it("throws when startChildWorkflow is not available", async () => {
    const ctx = makeCtx({ name: "child-wf", version: "1.0.0", inputs: {} });
    await expect(subStep.run(ctx as any)).rejects.toMatchObject({
      code: "SUB_WORKFLOW_NOT_AVAILABLE",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx jest test/steps/sub-workflow-step.test.ts --verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SubWorkflowStep**

Create `packages/core/src/steps/sub-workflow-step.ts`:

```typescript
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { WfeError } from "../errors";

export class SubWorkflowStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (!ctx.startChildWorkflow) {
      throw new WfeError("core.subWorkflow requires the startChildWorkflow callback on StepContext", {
        statusCode: 500,
        code: "SUB_WORKFLOW_NOT_AVAILABLE",
      });
    }

    const { name, version, inputs } = ctx.inputs as {
      name: string;
      version: string;
      inputs: Record<string, unknown>;
    };

    const childRunId = await ctx.startChildWorkflow({ name, version, inputs: inputs ?? {} });

    ctx.step.outputs = { childRunId };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
```

- [ ] **Step 4: Wire queue and startChildWorkflow into StepContext in RunExecutor**

Modify `packages/core/src/engine/run-executor.ts` — in the `executeStep` method, where `ctx` is built (around line 132-135). Change:

```typescript
      const ctx: StepContext = {
        config, logger: this.log, services: this.services,
        run, step: stepRun, stepNumber, inputs, body, isResume,
      };
```

To:

```typescript
      const ctx: StepContext = {
        config, logger: this.log, services: this.services,
        run, step: stepRun, stepNumber, inputs, body, isResume,
        queue: this.queue ? {
          publish: (q: string, msg: unknown) =>
            this.queue!.publish(q, msg as import("../queue/types").WorkflowMessage),
        } : undefined,
        startChildWorkflow: (input) =>
          this.startWorkflow({ tenantId: run.tenantId, ...input }),
      };
```

- [ ] **Step 5: Register and export**

Add to `registerBuiltInSteps` in `packages/core/src/registry/step-registry.ts`:

```typescript
import { SubWorkflowStep } from "../steps/sub-workflow-step";

  registry.register({
    type: "core.subWorkflow",
    version: "1.0.0",
    description: "Starts a child workflow run (fire-and-forget).",
    factory: (params) => new SubWorkflowStep(params),
  });
```

Add to `packages/core/src/index.ts`:

```typescript
export * from "./steps/sub-workflow-step";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run build && cd packages/core && npx jest test/steps/sub-workflow-step.test.ts --verbose`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): add core.subWorkflow step and wire queue/startChildWorkflow into StepContext"
```

---

### Task 5: Definition snapshotting

**Files:**
- Create: `packages/core/src/db/migrations/0004-definition-snapshot.ts`
- Modify: `packages/core/src/entities/workflow-run.ts` — add `definitionSnapshotJson` column + transient + shuttle
- Modify: `packages/core/src/engine/workflow-manager.ts` — snapshot in `startWorkflow`
- Modify: `packages/core/src/engine/run-executor.ts` — prefer snapshot in `definitionStepsFor`
- Modify: `packages/core/src/db/db-context.ts` — register migration
- Create: `packages/core/test/engine/definition-snapshot.test.ts`

**Interfaces:**
- Consumes: `WorkflowRun` entity, `WorkflowManager.startWorkflow`, `RunExecutor.definitionStepsFor`, `DefinitionRepository`, `DbContext`
- Produces: `WorkflowRun.definitionSnapshot` (transient `WorkflowDefinitionBody | undefined`), `WorkflowRun.definitionSnapshotJson` (column), migration `DefinitionSnapshot0004`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/engine/definition-snapshot.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { RunExecutor } from "../../src/engine/run-executor";
import { ExpressionEvaluator } from "../../src/expression/evaluator";
import { StepRegistry, registerBuiltInSteps } from "../../src/registry/step-registry";
import { DefinitionRepository } from "../../src/repositories/definition-repository";
import { RunRepository } from "../../src/repositories/run-repository";

jest.setTimeout(120000);

describe("Definition snapshotting", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let executor: RunExecutor;
  let definitions: DefinitionRepository;
  let runs: RunRepository;
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
    definitions = new DefinitionRepository(db);
    runs = new RunRepository(db);
  });

  afterAll(async () => {
    evaluator.dispose();
    await db.close();
    await container.stop();
  });

  it("persists the definition body as a snapshot on the run", async () => {
    await definitions.create({
      tenantId: "default", name: "snap-1", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: { steps: [
        { stepName: "A", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
      ] } as any,
    });

    const runId = await executor.startWorkflow({
      tenantId: "default", name: "snap-1", version: "1.0.0", inputs: {},
    });
    const run = await runs.findById("default", runId);
    expect(run!.definitionSnapshot).toBeDefined();
    expect(run!.definitionSnapshot!.steps).toHaveLength(1);
    expect(run!.definitionSnapshot!.steps[0].stepName).toBe("A");
  });

  it("uses the snapshot, not the current definition, on restart", async () => {
    // Create and run a 2-step workflow
    const def = await definitions.create({
      tenantId: "default", name: "snap-2", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: { steps: [
        { stepName: "First", stepVersion: "1.0.0", stepType: "core.transform",
          stepInputs: [{ targetFieldName: "x", modelEvaluationExpression: "Number(1)" }] },
        { stepName: "Second", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
      ] } as any,
    });

    const runId = await executor.startWorkflow({
      tenantId: "default", name: "snap-2", version: "1.0.0", inputs: {},
    });
    await executor.start("default", runId);

    // Now update the definition (add a step) — this should NOT affect the run
    await definitions.update("default", def.id!, {
      definition: { steps: [
        { stepName: "First", stepVersion: "1.0.0", stepType: "core.transform",
          stepInputs: [{ targetFieldName: "x", modelEvaluationExpression: "Number(999)" }] },
        { stepName: "Injected", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
        { stepName: "Second", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
      ] } as any,
    });

    // Restart from step 0 — should use the ORIGINAL 2-step definition
    const restarted = await executor.restartFromStep("default", runId, 0);
    // The run should complete with 2 steps, not 3
    expect(restarted.stepRuns).toHaveLength(2);
    expect(restarted.status).toBe(WorkflowStatus.COMPLETE);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && cd packages/core && npx jest test/engine/definition-snapshot.test.ts --verbose`
Expected: FAIL — `definitionSnapshot` is undefined (not yet persisted)

- [ ] **Step 3: Create migration 0004**

Create `packages/core/src/db/migrations/0004-definition-snapshot.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class DefinitionSnapshot0004 implements MigrationInterface {
  name = "DefinitionSnapshot0004";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE workflow_run ADD COLUMN definition_snapshot jsonb`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE workflow_run DROP COLUMN definition_snapshot`);
  }
}
```

- [ ] **Step 4: Register migration in DbContext**

Modify `packages/core/src/db/db-context.ts` — add import and registration:

```typescript
import { DefinitionSnapshot0004 } from "./migrations/0004-definition-snapshot";

// In connectionOptions(), add to migrations array:
migrations: [Init0001, QueueSupport0002, ServerSupport0003, DefinitionSnapshot0004],
```

- [ ] **Step 5: Add snapshot column and shuttle to WorkflowRun entity**

Modify `packages/core/src/entities/workflow-run.ts`:

Add the column after `stateJson`:

```typescript
  @Column({ type: "jsonb", nullable: true })
  definitionSnapshotJson?: unknown;
```

Add the transient field after `state`:

```typescript
  definitionSnapshot?: import("@wfe/sdk").WorkflowDefinitionBody;
```

Add to `copyParametersToJson()`:

```typescript
    this.definitionSnapshotJson = this.definitionSnapshot;
```

Add to `loadParametersFromJson()`:

```typescript
    this.definitionSnapshot = (this.definitionSnapshotJson as import("@wfe/sdk").WorkflowDefinitionBody) ?? undefined;
```

- [ ] **Step 6: Snapshot in startWorkflow**

Modify `packages/core/src/engine/workflow-manager.ts` — in `startWorkflow`, after `validateAgainstRegistry` and before setting `run.inputs`:

```typescript
    run.definitionSnapshot = definition.definition;
```

- [ ] **Step 7: Prefer snapshot in definitionStepsFor**

Modify `packages/core/src/engine/run-executor.ts` — change `definitionStepsFor`:

```typescript
  protected async definitionStepsFor(run: WorkflowRun): Promise<StepDefinition[]> {
    if (run.definitionSnapshot) {
      return run.definitionSnapshot.steps;
    }
    // Legacy path: runs created before definition snapshotting was added
    const definition = await this.lookupDefinition({
      tenantId: run.tenantId, name: run.name, version: run.version,
      inputs: {}, definitionId: run.definitionId,
    });
    return definition.definition.steps;
  }
```

Also add `StepDefinition` to the import from `@wfe/sdk` at the top of the file (it should already be there or importable from `WorkflowDefinitionBody`).

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm run build && cd packages/core && npx jest test/engine/definition-snapshot.test.ts --verbose`
Expected: PASS (2 tests)

- [ ] **Step 9: Run the full core suite to check for regressions**

Run: `npm run build && npm test -w @wfe/core 2>&1 | tail -20`
Expected: All existing tests still pass (22+ suites)

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(core): snapshot definition body onto run at creation, prefer snapshot on restart"
```

---

### Task 6: Batch job entity, repository, migration

**Files:**
- Create: `packages/core/src/entities/batch-job.ts`
- Create: `packages/core/src/repositories/batch-job-repository.ts`
- Create: `packages/core/src/db/migrations/0005-batch-jobs.ts`
- Modify: `packages/core/src/db/db-context.ts` — register entity + migration
- Modify: `packages/core/src/index.ts` — export new modules
- Create: `packages/core/test/repositories/batch-job-repository.test.ts`

**Interfaces:**
- Consumes: `DbContext`, `WorkflowRun` (for progress queries), `WfeError`
- Produces:
  - `BatchJob` entity with columns: `id`, `tenantId`, `name`, `definitionName`, `definitionVersion`, `status`, `totalCount`, `inputsJson`, `runIdsJson`, `message`, `createdDate`, `updatedDate`
  - `BatchJobRepository` with methods: `create(job: Partial<BatchJob>): Promise<BatchJob>`, `findById(tenantId: string, id: number): Promise<BatchJob | null>`, `list(tenantId: string, filters?: { status?: string; limit?: number; offset?: number }): Promise<BatchJob[]>`, `update(tenantId: string, id: number, updates: Partial<BatchJob>): Promise<BatchJob>`, `computeProgress(tenantId: string, id: number): Promise<{ completedCount: number; failedCount: number; runningCount: number }>`
  - Migration `BatchJobs0005`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/repositories/batch-job-repository.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DbContext } from "../../src/db/db-context";
import { BatchJobRepository } from "../../src/repositories/batch-job-repository";

jest.setTimeout(120000);

describe("BatchJobRepository", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let repo: BatchJobRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    db = new DbContext({ dbUrl: container.getConnectionUri() });
    await db.runMigrations();
    repo = new BatchJobRepository(db);
  });

  afterAll(async () => {
    await db.close();
    await container.stop();
  });

  it("creates and retrieves a batch job", async () => {
    const job = await repo.create({
      tenantId: "default",
      name: "test-batch",
      definitionName: "my-workflow",
      definitionVersion: "1.0.0",
      status: "pending",
      totalCount: 3,
      inputs: [{ a: 1 }, { a: 2 }, { a: 3 }],
      runIds: [],
    });
    expect(job.id).toBeDefined();

    const found = await repo.findById("default", job.id!);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("test-batch");
    expect(found!.inputs).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(found!.totalCount).toBe(3);
  });

  it("lists batch jobs with status filter", async () => {
    await repo.create({
      tenantId: "default", name: "b1", definitionName: "wf", definitionVersion: "1",
      status: "running", totalCount: 1, inputs: [{}], runIds: [],
    });
    await repo.create({
      tenantId: "default", name: "b2", definitionName: "wf", definitionVersion: "1",
      status: "complete", totalCount: 1, inputs: [{}], runIds: [],
    });

    const running = await repo.list("default", { status: "running" });
    expect(running.every((j) => j.status === "running")).toBe(true);
  });

  it("updates a batch job", async () => {
    const job = await repo.create({
      tenantId: "default", name: "b-update", definitionName: "wf", definitionVersion: "1",
      status: "pending", totalCount: 1, inputs: [{}], runIds: [],
    });
    const updated = await repo.update("default", job.id!, {
      status: "running",
      runIds: [10, 20],
    });
    expect(updated.status).toBe("running");
    expect(updated.runIds).toEqual([10, 20]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx jest test/repositories/batch-job-repository.test.ts --verbose`
Expected: FAIL — modules not found

- [ ] **Step 3: Create migration 0005**

Create `packages/core/src/db/migrations/0005-batch-jobs.ts`:

```typescript
import { MigrationInterface, QueryRunner, Table } from "typeorm";

export class BatchJobs0005 implements MigrationInterface {
  name = "BatchJobs0005";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(new Table({
      name: "batch_job",
      columns: [
        { name: "id", type: "serial", isPrimary: true },
        { name: "tenant_id", type: "varchar", length: "64", isNullable: false, default: "'default'" },
        { name: "name", type: "varchar", length: "256", isNullable: false },
        { name: "definition_name", type: "varchar", length: "256", isNullable: false },
        { name: "definition_version", type: "varchar", length: "50", isNullable: false },
        { name: "status", type: "varchar", length: "50", isNullable: false, default: "'pending'" },
        { name: "total_count", type: "int", isNullable: false, default: "0" },
        { name: "inputs_json", type: "jsonb", isNullable: false, default: "'[]'::jsonb" },
        { name: "run_ids_json", type: "jsonb", isNullable: false, default: "'[]'::jsonb" },
        { name: "message", type: "varchar", length: "4000", isNullable: true },
        { name: "created_date", type: "timestamptz", default: "now()" },
        { name: "updated_date", type: "timestamptz", default: "now()" },
      ],
      indices: [
        { columnNames: ["tenant_id", "status"] },
      ],
    }));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("batch_job");
  }
}
```

- [ ] **Step 4: Create BatchJob entity**

Create `packages/core/src/entities/batch-job.ts`:

```typescript
import {
  AfterLoad, BeforeInsert, BeforeUpdate, Column, CreateDateColumn,
  Entity, PrimaryGeneratedColumn, UpdateDateColumn,
} from "typeorm";

@Entity({ name: "batch_job" })
export class BatchJob {
  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: "varchar", length: 64, nullable: false, default: "default" })
  tenantId!: string;

  @Column({ type: "varchar", length: 256, nullable: false })
  name!: string;

  @Column({ type: "varchar", length: 256, nullable: false })
  definitionName!: string;

  @Column({ type: "varchar", length: 50, nullable: false })
  definitionVersion!: string;

  @Column({ type: "varchar", length: 50, nullable: false, default: "pending" })
  status!: string;

  @Column({ type: "int", nullable: false, default: 0 })
  totalCount!: number;

  @Column({ type: "jsonb", nullable: false, default: () => "'[]'::jsonb" })
  inputsJson?: unknown[];

  @Column({ type: "jsonb", nullable: false, default: () => "'[]'::jsonb" })
  runIdsJson?: number[];

  @Column({ type: "varchar", length: 4000, nullable: true })
  message?: string;

  // Transient
  inputs: unknown[] = [];
  runIds: number[] = [];

  @BeforeInsert()
  @BeforeUpdate()
  copyToJson(): void {
    this.inputsJson = this.inputs;
    this.runIdsJson = this.runIds;
  }

  @AfterLoad()
  loadFromJson(): void {
    this.inputs = (this.inputsJson as unknown[]) ?? [];
    this.runIds = (this.runIdsJson as number[]) ?? [];
  }

  @CreateDateColumn()
  createdDate!: Date;

  @UpdateDateColumn()
  updatedDate!: Date;
}
```

- [ ] **Step 5: Create BatchJobRepository**

Create `packages/core/src/repositories/batch-job-repository.ts`:

```typescript
import { DbContext } from "../db/db-context";
import { BatchJob } from "../entities/batch-job";
import { WfeError } from "../errors";

export class BatchJobRepository {
  constructor(private readonly db: DbContext) {}

  async create(data: Partial<BatchJob>): Promise<BatchJob> {
    const ds = await this.db.getDataSource();
    const job = new BatchJob();
    Object.assign(job, data);
    return ds.getRepository(BatchJob).save(job);
  }

  async findById(tenantId: string, id: number): Promise<BatchJob | null> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(BatchJob).findOneBy({ id, tenantId });
  }

  async list(
    tenantId: string,
    filters?: { status?: string; limit?: number; offset?: number },
  ): Promise<BatchJob[]> {
    const ds = await this.db.getDataSource();
    const qb = ds.getRepository(BatchJob).createQueryBuilder("job")
      .where("job.tenantId = :tenantId", { tenantId })
      .orderBy("job.createdDate", "DESC")
      .take(filters?.limit ?? 50)
      .skip(filters?.offset ?? 0);

    if (filters?.status) {
      qb.andWhere("job.status = :status", { status: filters.status });
    }

    return qb.getMany();
  }

  async update(tenantId: string, id: number, updates: Partial<BatchJob>): Promise<BatchJob> {
    const job = await this.findById(tenantId, id);
    if (!job) {
      throw new WfeError(`Batch job ${id} not found`, { statusCode: 404, code: "BATCH_JOB_NOT_FOUND" });
    }
    Object.assign(job, updates);
    const ds = await this.db.getDataSource();
    return ds.getRepository(BatchJob).save(job);
  }

  async computeProgress(
    tenantId: string,
    id: number,
  ): Promise<{ completedCount: number; failedCount: number; runningCount: number }> {
    const job = await this.findById(tenantId, id);
    if (!job || job.runIds.length === 0) {
      return { completedCount: 0, failedCount: 0, runningCount: 0 };
    }
    const ds = await this.db.getDataSource();
    const rows: Array<{ status: string; count: string }> = await ds.query(
      `SELECT status, COUNT(*)::int AS count FROM workflow_run
       WHERE tenant_id = $1 AND id = ANY($2) GROUP BY status`,
      [tenantId, job.runIds],
    );

    let completedCount = 0;
    let failedCount = 0;
    let runningCount = 0;
    for (const row of rows) {
      if (row.status === "COMPLETE") completedCount = Number(row.count);
      else if (row.status === "FAILED") failedCount = Number(row.count);
      else if (row.status === "RUNNING" || row.status === "STARTING" || row.status === "WAITING") {
        runningCount += Number(row.count);
      }
    }
    return { completedCount, failedCount, runningCount };
  }
}
```

- [ ] **Step 6: Register entity and migration in DbContext**

Modify `packages/core/src/db/db-context.ts`:

```typescript
import { BatchJob } from "../entities/batch-job";
import { BatchJobs0005 } from "./migrations/0005-batch-jobs";

// In connectionOptions():
entities: [WorkflowDefinitionEntity, WorkflowRun, StepRun, IdempotencyKeyEntity, BatchJob],
migrations: [Init0001, QueueSupport0002, ServerSupport0003, DefinitionSnapshot0004, BatchJobs0005],
```

Add exports to `packages/core/src/index.ts`:

```typescript
export * from "./entities/batch-job";
export * from "./repositories/batch-job-repository";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run build && cd packages/core && npx jest test/repositories/batch-job-repository.test.ts --verbose`
Expected: PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): add BatchJob entity, repository, and migration"
```

---

### Task 7: Batch jobs controller + filter config + CLI plugin loading + OpenAPI + docs

**Files:**
- Create: `packages/server/src/controllers/batch-jobs.ts`
- Create: `packages/server/test/batch-jobs.test.ts`
- Modify: `packages/server/src/app.ts` — mount batch-jobs router
- Modify: `packages/server/src/controllers/system.ts` — add filter-configuration endpoint
- Modify: `packages/server/src/openapi/spec.ts` — add batch-job + filter-config routes
- Modify: `packages/server/src/cli/index.ts` — add `loadPlugins` call, `parseAsync` fix
- Modify: `packages/server/test/system.test.ts` — test filter-configuration
- Modify: `docs/handoff.md` — mark Phase 3 complete
- Modify: `docs/superpowers/carry-forward.md` — resolve delay NaN, parseAsync items
- Modify: `README.md` — Phase 4 sections

**Interfaces:**
- Consumes:
  - `BatchJobRepository` from Task 6: `create`, `findById`, `list`, `update`, `computeProgress`
  - `RunExecutor` from `@wfe/core`: `startWorkflow(input): Promise<number>`, `start(tenantId, runId): Promise<WorkflowRun>`
  - `loadPlugins` from Task 1: `loadPlugins(specifiers: string[], registry: StepRegistry, logger?: Logger): Promise<void>`
  - `StepRegistry.list()` for filter-configuration
- Produces:
  - `batchJobRoutes(deps): Router` with POST/GET `/batch-jobs`, GET `/batch-jobs/:id`, PUT `/batch-jobs/:id/cancel`
  - `GET /filter-configuration` on the system router
  - Updated CLI with `loadPlugins` and `parseAsync`

- [ ] **Step 1: Write the failing tests**

Add to `packages/server/test/system.test.ts` (append a new test):

```typescript
  it("GET /api/v1/filter-configuration returns filter metadata", async () => {
    const res = await request(app).get("/api/v1/filter-configuration");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("definitions");
    expect(res.body).toHaveProperty("runs");
    expect(res.body).toHaveProperty("steps");
    expect(res.body.steps.find((f: any) => f.field === "stepType").values).toContain("core.noop");
  });
```

Create `packages/server/test/batch-jobs.test.ts`:

```typescript
import "reflect-metadata";
import request from "supertest";
import { Express } from "express";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  DbContext, ExpressionEvaluator, RunExecutor, StepRegistry, registerBuiltInSteps,
  DefinitionRepository, validateDefinitionShape,
} from "@wfe/core";
import { WorkflowDefinitionStatus } from "@wfe/sdk";
import { createApp } from "../src/app";
import { NoneAuthProvider } from "../src/auth/none-provider";

jest.setTimeout(120000);

describe("Batch jobs", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let app: Express;
  let evaluator: ExpressionEvaluator;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    const executor = new RunExecutor({ config, db, registry, evaluator });
    app = createApp({ executor, db, registry, authProvider: new NoneAuthProvider(), evaluator });

    // Publish a definition for batch fan-out
    const defs = new DefinitionRepository(db);
    const body = await validateDefinitionShape({
      steps: [{ stepName: "T", stepVersion: "1.0.0", stepType: "core.transform",
        stepInputs: [{ targetFieldName: "x", modelEvaluationExpression: "workflowState.inputs.x" }] }],
    });
    await defs.create({
      tenantId: "default", name: "batch-target", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED, definition: body,
    });
  });

  afterAll(async () => {
    evaluator.dispose();
    await db.close();
    await container.stop();
  });

  it("POST /api/v1/batch-jobs creates a batch and fans out runs", async () => {
    const res = await request(app)
      .post("/api/v1/batch-jobs")
      .send({
        name: "test-batch",
        definitionName: "batch-target",
        definitionVersion: "1.0.0",
        inputs: [{ x: 1 }, { x: 2 }, { x: 3 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.totalCount).toBe(3);
    expect(res.body.runIds).toHaveLength(3);
    expect(res.body.status).toBe("running");
  });

  it("GET /api/v1/batch-jobs lists batch jobs", async () => {
    const res = await request(app).get("/api/v1/batch-jobs");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/v1/batch-jobs/:id returns batch with progress", async () => {
    const create = await request(app)
      .post("/api/v1/batch-jobs")
      .send({
        name: "progress-batch",
        definitionName: "batch-target",
        definitionVersion: "1.0.0",
        inputs: [{ x: 10 }],
      });
    const res = await request(app).get(`/api/v1/batch-jobs/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("progress");
    expect(res.body.progress).toHaveProperty("completedCount");
  });

  it("PUT /api/v1/batch-jobs/:id/cancel cancels the batch", async () => {
    const create = await request(app)
      .post("/api/v1/batch-jobs")
      .send({
        name: "cancel-batch",
        definitionName: "batch-target",
        definitionVersion: "1.0.0",
        inputs: [{ x: 20 }],
      });
    const res = await request(app).put(`/api/v1/batch-jobs/${create.body.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && cd packages/server && npx jest test/batch-jobs.test.ts --verbose`
Expected: FAIL — routes not mounted, controller not found

- [ ] **Step 3: Implement batch-jobs controller**

Create `packages/server/src/controllers/batch-jobs.ts`:

```typescript
import { Router } from "express";
import {
  RunExecutor, DbContext, BatchJobRepository,
} from "@wfe/core";
import { AuthenticatedRequest } from "../auth/types";

export function batchJobRoutes(deps: { executor: RunExecutor; db: DbContext }): Router {
  const router = Router();
  const batchJobs = new BatchJobRepository(deps.db);

  router.post("/batch-jobs", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { name, definitionName, definitionVersion, inputs } = req.body;

      if (!Array.isArray(inputs) || inputs.length === 0) {
        res.status(400).json({ error: { code: "BATCH_INVALID_INPUTS", message: "inputs must be a non-empty array" } });
        return;
      }

      const job = await batchJobs.create({
        tenantId,
        name,
        definitionName,
        definitionVersion,
        status: "running",
        totalCount: inputs.length,
        inputs,
        runIds: [],
      });

      const runIds: number[] = [];
      try {
        for (const input of inputs) {
          const runId = await deps.executor.startWorkflow({
            tenantId,
            name: definitionName,
            version: definitionVersion,
            inputs: input ?? {},
          });
          await deps.executor.start(tenantId, runId);
          runIds.push(runId);
        }
        await batchJobs.update(tenantId, job.id!, { runIds, status: "running" });
      } catch (err) {
        await batchJobs.update(tenantId, job.id!, {
          runIds,
          status: "failed",
          message: (err as Error).message,
        });
      }

      const result = await batchJobs.findById(tenantId, job.id!);
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  router.get("/batch-jobs", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { status, limit, offset } = req.query;
      const jobs = await batchJobs.list(tenantId, {
        status: status as string | undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json(jobs);
    } catch (err) { next(err); }
  });

  router.get("/batch-jobs/:id", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const job = await batchJobs.findById(tenantId, Number(req.params.id));
      if (!job) {
        res.status(404).json({ error: { code: "BATCH_JOB_NOT_FOUND", message: `Batch job ${req.params.id} not found` } });
        return;
      }
      const progress = await batchJobs.computeProgress(tenantId, job.id!);
      res.json({ ...job, progress });
    } catch (err) { next(err); }
  });

  router.put("/batch-jobs/:id/cancel", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const job = await batchJobs.findById(tenantId, Number(req.params.id));
      if (!job) {
        res.status(404).json({ error: { code: "BATCH_JOB_NOT_FOUND", message: `Batch job ${req.params.id} not found` } });
        return;
      }

      // Cancel all non-terminal runs
      for (const runId of job.runIds) {
        try {
          await deps.executor.cancel(tenantId, runId);
        } catch {
          // Run may already be terminal — ignore
        }
      }

      const updated = await batchJobs.update(tenantId, job.id!, { status: "cancelled" });
      res.json(updated);
    } catch (err) { next(err); }
  });

  return router;
}
```

- [ ] **Step 4: Mount batch-jobs router in app.ts**

Modify `packages/server/src/app.ts`:

Add import:

```typescript
import { batchJobRoutes } from "./controllers/batch-jobs";
```

Add after the `stepRoutes` line:

```typescript
  app.use("/api/v1", batchJobRoutes({ executor: deps.executor, db: deps.db }));
```

- [ ] **Step 5: Add filter-configuration endpoint to system controller**

Modify `packages/server/src/controllers/system.ts` — inside the `if (deps?.registry)` block, after the `openapi.json` route:

```typescript
    router.get("/filter-configuration", (_req, res) => {
      const stepTypes = deps.registry!.list().map((r) => r.type);
      res.json({
        definitions: [
          { field: "status", type: "enum", values: ["draft", "published", "archived"] },
          { field: "name", type: "text" },
        ],
        runs: [
          { field: "status", type: "enum", values: [
            "STARTING", "RUNNING", "COMPLETE", "FAILED", "CANCELLED", "CANCELLING", "WAITING", "PAUSED",
          ] },
          { field: "name", type: "text" },
          { field: "createdDate", type: "dateRange" },
        ],
        steps: [
          { field: "status", type: "enum", values: [
            "NEW", "RUNNING", "COMPLETE", "FAILED", "CANCELLED", "WAITING", "SKIPPED",
          ] },
          { field: "stepType", type: "enum", values: stepTypes },
          { field: "externalServiceName", type: "text" },
        ],
      });
    });
```

- [ ] **Step 6: Add batch-job routes to OpenAPI spec**

Modify `packages/server/src/openapi/spec.ts` — add to the `paths` object before the closing brace:

```typescript
      "/api/v1/batch-jobs": {
        post: {
          summary: "Create a batch job (fan out a workflow over N inputs)",
          operationId: "createBatchJob",
          tags: ["Batch Jobs"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object",
            properties: {
              name: { type: "string" }, definitionName: { type: "string" },
              definitionVersion: { type: "string" },
              inputs: { type: "array", items: { type: "object" } },
            },
            required: ["name", "definitionName", "definitionVersion", "inputs"],
          } } } },
          responses: { 201: { description: "Batch created and fan-out started" }, 400: { description: "Validation error" } },
        },
        get: {
          summary: "List batch jobs",
          operationId: "listBatchJobs",
          tags: ["Batch Jobs"],
          parameters: [
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { 200: { description: "Batch jobs" } },
        },
      },
      "/api/v1/batch-jobs/{id}": {
        get: {
          summary: "Get batch job with progress",
          operationId: "getBatchJob",
          tags: ["Batch Jobs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Batch job with progress" }, 404: { description: "Not found" } },
        },
      },
      "/api/v1/batch-jobs/{id}/cancel": {
        put: {
          summary: "Cancel a batch job and all its runs",
          operationId: "cancelBatchJob",
          tags: ["Batch Jobs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Cancelled" }, 404: { description: "Not found" } },
        },
      },
      "/api/v1/filter-configuration": {
        get: {
          summary: "Filter metadata for the UI",
          operationId: "getFilterConfiguration",
          tags: ["System"],
          responses: { 200: { description: "Filter descriptors for definitions, runs, and steps" } },
        },
      },
```

- [ ] **Step 7: Fix CLI — add loadPlugins + parseAsync**

Modify `packages/server/src/cli/index.ts`:

Add import:

```typescript
import { loadPlugins } from "@wfe/core";
```

In the `serve` command action, after `registerBuiltInSteps(registry)`:

```typescript
    await loadPlugins(config.plugins, registry, log);
```

In the `worker` command action, after `registerBuiltInSteps(registry)`:

```typescript
    await loadPlugins(config.plugins, registry, log);
```

In the `import` command action, after `registerBuiltInSteps(registry)`:

```typescript
    await loadPlugins(config.plugins, registry, log);
```

Change the last line from `program.parse()` to:

```typescript
program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 8: Update docs**

Update `docs/handoff.md` — change "Phases 3–6 are unbuilt" to "Phase 3 is complete; Phases 4–6 continue." Change the "Not built" paragraph to reflect current state. Update the test counts to include `@wfe/server`.

Update `docs/superpowers/carry-forward.md`:
- Mark "delay-step NaN guard" as resolved: `### ~~\`delay-step.ts\` has no NaN guard~~ (resolved, Phase 4)` with resolution text about the `WfeError` guard added.
- Add a new carry-forward item for `parseAsync` fix if not already resolved inline.

Update `README.md` — mark Phase 4 ✅ in the roadmap table. Add a brief "Phase 4" paragraph to the status section. Add `core.http`, `core.condition`, `core.subWorkflow`, `core.emitEvent` to the step types documentation. Add batch-job routes to the REST API route table. Mention plugin loading in the configuration section under `WFE_PLUGINS`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm run build && npm test 2>&1 | tail -30`
Expected: All suites pass — core 24+/170+, sdk 3/12, server 7+/50+. No deprecation warnings.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(server): add batch-jobs controller, filter-configuration, CLI plugin loading, Phase 4 docs"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ Plugin loader (§3) → Task 1
- ✅ StepContext additions (§4.1) → Task 2
- ✅ core.condition (§4.2) → Task 2
- ✅ core.emitEvent (§4.2) → Task 2
- ✅ core.http (§4.2) → Task 3
- ✅ core.subWorkflow (§4.2) → Task 4
- ✅ Executor context wiring (§4.2) → Task 4
- ✅ Definition snapshotting (§5) → Task 5
- ✅ Batch job entity + repository (§6) → Task 6
- ✅ Batch job controller (§6.4) → Task 7
- ✅ Filter configuration (§7) → Task 7
- ✅ Delay NaN guard (§8.1) → Task 2
- ✅ CLI parseAsync (§8.2) → Task 7
- ✅ handoff.md update (§8.3) → Task 7
- ✅ carry-forward.md update (§8.4) → Task 7
- ✅ README update → Task 7
- ✅ OpenAPI update → Task 7
- ✅ Sample plugin (§3.3) → Task 1

**2. Placeholder scan:** No TBDs, TODOs, "fill in" or "similar to" patterns found.

**3. Type consistency:**
- `loadPlugins(specifiers: string[], registry: StepRegistry, logger?: Logger): Promise<void>` — consistent between Task 1 (definition) and Task 7 (usage in CLI)
- `BatchJobRepository` methods — consistent between Task 6 (definition) and Task 7 (usage in controller)
- `StepContext.queue.publish(queue: string, msg: unknown)` — consistent between Task 2 (SDK definition) and Task 4 (executor wiring)
- `StepContext.startChildWorkflow` — consistent between Task 2 (SDK definition) and Task 4 (implementation + executor wiring)
