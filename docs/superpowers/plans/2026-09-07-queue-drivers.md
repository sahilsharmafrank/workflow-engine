# Queue Drivers Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine pluggable queue drivers so a suspended run is resumed by a message rather than by the caller, with SQS and RabbitMQ shipped and more addable without touching core.

**Architecture:** A `QueueDriver` interface with a name-keyed registry, three implementations (`memory`, `rabbitmq`, `sqs`), and a `WorkflowMessage` envelope. Core owns enqueueing: when a step suspends, the executor publishes the resume message itself, chaining re-enqueues when a delay exceeds the driver's native limit. A worker runtime subscribes to the delay and response queues and calls back into `RunExecutor.resume`. Delivery is at-least-once, so the Phase 1 resume guards remain the correctness boundary; a version column turns concurrent double-delivery from a silent lost update into a loud conflict.

**Tech Stack:** Node ^24, TypeScript 5.9 (CommonJS), TypeORM 0.3 + Postgres, `amqplib` for RabbitMQ, `@aws-sdk/client-sqs` for SQS, jest + ts-jest, `@testcontainers/postgresql` / `@testcontainers/rabbitmq` / `@testcontainers/localstack`.

**Spec:** `docs/superpowers/specs/2026-09-07-standalone-workflow-engine-design.md` — §3.1 (execution model and the three suspension modes), §7.2 (`StepContext`), §8 (queue drivers).

**Predecessor:** `docs/superpowers/plans/2026-09-07-core-engine.md` (Phase 1, complete — 101 tests, `feat/core-engine`).

## Global Constraints

- Node `^24.0.0`; npm `>=11`. TypeScript `^5.9.3`, `module: commonjs`.
- **No `@mast/*` dependency anywhere.** No domain vocabulary in shipped code: media, IMF, CPL, order, Genie, Baton, Wonderland, DeweyVision, portal.
- Expression evaluation stays inside the isolate sandbox. `new Function`/`eval` remain banned in `@wfe/core` outside tests asserting the ban.
- Every definition and run row carries `tenantId`; every repository query filters on it. **New in this plan:** `step_run` gains `tenant_id` too.
- Statuses come from the `WorkflowStatus` enum in `@wfe/sdk`. No string literals for status.
- `@wfe/sdk` keeps **zero runtime dependencies**. Queue client libraries belong to `@wfe/core` only.
- Delivery is at-least-once on every driver. Idempotency comes from the run-state guards in `RunExecutor.run`, never from the broker.
- Drivers must not import each other, and core must not import a driver module directly — everything goes through the registry.
- TDD: failing test first, run it to confirm the failure, then implement. Commit at the end of each task.

## What Phase 1 already provides

Read before starting: `packages/core/src/engine/run-executor.ts` and `packages/core/src/engine/workflow-manager.ts`.

- `RunExecutor extends WorkflowManager`, with `protected` `config`, `db`, `registry`, `evaluator`, `services`, `log`, `definitions`, `runs`, and `lookupDefinition`.
- `executeStep(run, stepNumber, body?)` → `{ run, delaySeconds? }`, executing exactly one step.
- `run(tenantId, runId, stepNumber, body?)` — the advance loop, with three resume guards (missing run, `isResumeBlocked`, stale `currentStep`, where `-1` admits only step 0) and a mid-loop status re-read that stops the loop when a run is cancelled out of band.
- `start`, `cancel`, `restartFromStep(tenantId, runId, stepNumber)` with bounds and cancelled-run checks.
- `RunRepository` has `save`, `findById`, `getStatus`. `DefinitionRepository` has `create`, `findById`, `findPublished`.
- `WorkflowRun` has eager `stepRuns`, transient jsonb params, `@AfterLoad` step sort. `StepRun` has `externalServiceName`, `targetAgent`, `priority`, `remoteTaskStatus`, `progress` — all currently written but unread.
- `EngineConfig` = `dbUrl`, `showSql`, `expressionTimeoutMs`, `expressionValues`, `expressionConfigKeys`.

## File Structure

```
packages/sdk/src/
  step-context.ts        MODIFY: StepSuspension union, RunStepResponse.suspend, ctx.isResume
  base-step.ts           MODIFY: start() alongside run()
packages/core/src/
  queue/types.ts         WorkflowMessage, QueueDefinition, QueueDriver, Unsubscribe
  queue/registry.ts      registerQueueDriver / createQueueDriver / listQueueDrivers
  queue/memory-driver.ts in-process driver for tests and single-node dev
  queue/rabbitmq-driver.ts
  queue/sqs-driver.ts
  queue/names.ts         queue naming + the service→queue routing map
  engine/suspension.ts   translates a StepSuspension into a publish
  engine/run-executor.ts MODIFY: queue-aware suspension, resume(), callback()
  entities/workflow-run.ts  MODIFY: @VersionColumn
  entities/step-run.ts      MODIFY: tenantId
  db/migrations/0002-queue-support.ts
  repositories/run-repository.ts MODIFY: optimistic-concurrency save
  steps/external-task-step.ts    core.externalTask
  worker/worker.ts       subscription runtime + graceful shutdown
docker-compose.yml       postgres + rabbitmq for local development
```

---

### Task 1: SDK suspension model and the start/run split

**Files:**
- Modify: `packages/sdk/src/step-context.ts`, `packages/sdk/src/base-step.ts`
- Modify: `packages/core/src/steps/noop-step.ts`, `packages/core/src/steps/transform-step.ts`
- Modify: `packages/core/src/engine/run-executor.ts` (read `suspend` instead of `delaySeconds`)
- Modify: `packages/core/test/engine/execute-step.test.ts`, `packages/core/test/engine/run-loop.test.ts` (steps that suspend)
- Test: `packages/sdk/test/base-step.test.ts`

**Interfaces:**
- Consumes: Phase 1's `BaseStep`, `StepContext`, `RunStepResponse`.
- Produces: `type StepSuspension = { kind: "delay"; delaySeconds: number } | { kind: "awaitCallback"; queue?: string; correlationId?: string }`; `RunStepResponse { stepState: StepRunLike; suspend?: StepSuspension }`; `StepContext.isResume: boolean`; `BaseStep.start(ctx): Promise<void>` replacing `onBeforeRun`. Tasks 4, 5 and 7 branch on `suspend.kind`.

**Why this shape:** spec §3.1 has three suspension modes — run on, sleep for N seconds, or wait for an external callback. Phase 1 modelled only the sleep, so an external step had to fake a delay to suspend and had no way to say "wake me when the reply arrives." A discriminated union makes the third mode expressible and makes the executor's branch exhaustive. `isResume` and `start` let a step distinguish first entry from resumption, which is the distinction spec §7.2's `start`/`run` split existed to provide.

- [ ] **Step 1: Write the failing test**

`packages/sdk/test/base-step.test.ts` — add to the existing file:

```typescript
import { BaseStep, RunStepResponse, StepContext, StepParams, WorkflowStatus } from "../src";

class SuspendingStep extends BaseStep {
  startCalls = 0;
  runCalls = 0;

  async start(_ctx: StepContext): Promise<void> {
    this.startCalls += 1;
  }

  async run(ctx: StepContext): Promise<RunStepResponse> {
    this.runCalls += 1;
    if (!ctx.isResume) {
      ctx.step.status = WorkflowStatus.WAITING;
      return { stepState: ctx.step, suspend: { kind: "delay", delaySeconds: 30 } };
    }
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

describe("suspension model", () => {
  const params: StepParams = { name: "S", version: "1.0.0", type: "test.suspending" };

  function ctx(isResume: boolean): StepContext {
    return {
      config: {}, services: {}, inputs: {}, stepNumber: 0, isResume,
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      run: {
        tenantId: "default", name: "t", version: "1.0.0", currentStep: 0,
        status: WorkflowStatus.RUNNING, inputs: {}, outputs: {}, state: {},
      },
      step: {
        stepNumber: 0, stepName: "S", stepType: "test.suspending",
        status: WorkflowStatus.RUNNING, inputs: {}, outputs: {}, state: {},
      },
    };
  }

  it("suspends with a delay on first entry", async () => {
    const step = new SuspendingStep(params);
    const response = await step.run(ctx(false));
    expect(response.suspend).toEqual({ kind: "delay", delaySeconds: 30 });
    expect(response.stepState.status).toBe(WorkflowStatus.WAITING);
  });

  it("completes without suspending on resume", async () => {
    const step = new SuspendingStep(params);
    const response = await step.run(ctx(true));
    expect(response.suspend).toBeUndefined();
    expect(response.stepState.status).toBe(WorkflowStatus.COMPLETE);
  });

  it("expresses an await-callback suspension", async () => {
    const suspension = { kind: "awaitCallback", queue: "billing", correlationId: "abc" } as const;
    expect(suspension.kind).toBe("awaitCallback");
  });

  it("provides a no-op start hook by default", async () => {
    class Bare extends BaseStep {
      async run(c: StepContext): Promise<RunStepResponse> { return { stepState: c.step }; }
    }
    await expect(new Bare(params).start(ctx(false))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/sdk -- base-step`
Expected: FAIL — `isResume` is not a property of `StepContext`, `suspend` is not a property of `RunStepResponse`, and `start` does not exist on `BaseStep`.

- [ ] **Step 3: Update the SDK types**

In `packages/sdk/src/step-context.ts`, replace the `RunStepResponse` interface and add the suspension union and `isResume`:

```typescript
/**
 * How a step asks the engine to suspend it. `delay` sleeps for a fixed period;
 * `awaitCallback` parks the step until an external worker replies, optionally
 * naming the queue the request was dispatched to and a correlation id to match
 * the reply against.
 */
export type StepSuspension =
  | { kind: "delay"; delaySeconds: number }
  | { kind: "awaitCallback"; queue?: string; correlationId?: string };

export interface RunStepResponse {
  stepState: StepRunLike;
  /** When set, the executor suspends the run rather than advancing. */
  suspend?: StepSuspension;
}
```

Add to `StepContext`:

```typescript
  /** False on first entry into this step, true when a resume message re-entered it. */
  isResume: boolean;
```

- [ ] **Step 4: Replace `onBeforeRun` with `start`**

In `packages/sdk/src/base-step.ts`:

```typescript
  /**
   * Called before `run` on **first entry** into the step, not on resumption.
   * Override for one-time setup — dispatching an external request, claiming a
   * resource. The default does nothing.
   */
  async start(_ctx: StepContext): Promise<void> {
    return;
  }
```

Delete `onBeforeRun`.

- [ ] **Step 5: Update the executor and built-in steps**

In `packages/core/src/engine/run-executor.ts`: derive `isResume` from **persisted state, not from the payload** —

```ts
// A step that suspended was left WAITING; re-entering it is by definition a
// resume. Deriving this from the payload instead would be wrong: a delay
// resume carries no body, so the step would re-enter as a first entry, suspend
// again, and the run would re-enqueue itself forever.
const isResume = stepRun.status === WorkflowStatus.WAITING;
```

Build the `StepContext` with that flag, call `await step.start(ctx)` only when `!isResume` (replacing the unconditional `onBeforeRun` call), and read the suspension from `response.suspend` — keeping `ExecuteStepResult` but changing its field:

```typescript
export interface ExecuteStepResult {
  run: WorkflowRun;
  suspend?: StepSuspension;
}
```

At the end of the success path, return `{ run: saved, suspend: response.suspend }`. In `run()`, replace `if (result.delaySeconds !== undefined)` with `if (result.suspend)`.

`noop-step.ts` and `transform-step.ts` need no logic change — they never suspended.

- [ ] **Step 6: Update Phase 1 tests that suspend**

In `execute-step.test.ts` and `run-loop.test.ts`, every step class that returned `{ stepState, delaySeconds: N }` now returns `{ stepState, suspend: { kind: "delay", delaySeconds: N } }`, and assertions on `result.delaySeconds` become assertions on `result.suspend`. Do not weaken any assertion while converting it — the run-loop suspend test must still prove the loop stopped and the run is `WAITING`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. Test count unchanged except for the 4 new SDK tests.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk packages/core
git commit -m "feat(sdk): model step suspension as a union and split start from run"
```

---

### Task 2: QueueDriver contract, registry and the in-memory driver

**Files:**
- Create: `packages/core/src/queue/types.ts`, `packages/core/src/queue/registry.ts`, `packages/core/src/queue/memory-driver.ts`, `packages/core/src/queue/names.ts`
- Test: `packages/core/test/queue/registry.test.ts`, `packages/core/test/queue/memory-driver.test.ts`

**Interfaces:**
- Consumes: `WfeError`.
- Produces:
  - `interface WorkflowMessage { tenantId: string; runId: number; stepNumber: number; kind: "resume" | "callback"; body?: unknown; correlationId?: string; attempt?: number }`
  - `interface QueueDefinition { queueName: string; delaySeconds?: number }`
  - `type Unsubscribe = () => Promise<void>`
  - `interface QueueDriver { readonly name: string; readonly maxDelaySeconds: number; ensureQueues(defs: QueueDefinition[]): Promise<void>; publish(queue: string, msg: WorkflowMessage, opts?: { delaySeconds?: number }): Promise<void>; subscribe(queue: string, handler: (msg: WorkflowMessage) => Promise<void>): Promise<Unsubscribe>; close(): Promise<void> }`
  - `registerQueueDriver(name: string, factory: QueueDriverFactory): void`, `createQueueDriver(name: string, options: QueueDriverOptions): QueueDriver`, `listQueueDrivers(): string[]`
  - `type QueueDriverFactory = (options: QueueDriverOptions) => QueueDriver`, `interface QueueDriverOptions { url?: string; prefix?: string; region?: string; [key: string]: unknown }`
  - `MemoryQueueDriver`
  - `DELAY_QUEUE`, `RESPONSE_QUEUE` constants and `serviceQueueName(service: string)` in `names.ts`
- Tasks 4–9 all consume these.

**Why a memory driver:** every test of the executor's enqueue logic, the delay-chaining maths and the worker runtime would otherwise need a broker container. The memory driver keeps those tests fast and deterministic, and doubles as a single-node dev default. It is a real driver behind the same interface, not a mock — spec §8's registry is explicitly open to more drivers.

`maxDelaySeconds` is on the interface because SQS caps native delay at 900s and RabbitMQ's TTL approach has no hard cap; core needs the number to decide when to chain (Task 4).

- [ ] **Step 1: Write the failing tests**

`packages/core/test/queue/registry.test.ts`:

```typescript
import { WfeError } from "../../src/errors";
import { MemoryQueueDriver } from "../../src/queue/memory-driver";
import { createQueueDriver, listQueueDrivers, registerQueueDriver } from "../../src/queue/registry";

describe("queue driver registry", () => {
  it("creates a registered driver by name", () => {
    const driver = createQueueDriver("memory", {});
    expect(driver).toBeInstanceOf(MemoryQueueDriver);
    expect(driver.name).toBe("memory");
  });

  it("lists the built-in drivers", () => {
    expect(listQueueDrivers()).toEqual(expect.arrayContaining(["memory"]));
  });

  it("throws an actionable error for an unknown driver", () => {
    expect(() => createQueueDriver("kafka", {})).toThrow(/kafka/);
    expect(() => createQueueDriver("kafka", {})).toThrow(/memory/);
  });

  it("rejects a duplicate registration", () => {
    registerQueueDriver("test.dup", () => new MemoryQueueDriver());
    expect(() => registerQueueDriver("test.dup", () => new MemoryQueueDriver())).toThrow(WfeError);
  });
});
```

`packages/core/test/queue/memory-driver.test.ts`:

```typescript
import { MemoryQueueDriver } from "../../src/queue/memory-driver";
import { WorkflowMessage } from "../../src/queue/types";

const msg = (runId: number): WorkflowMessage => ({
  tenantId: "default", runId, stepNumber: 0, kind: "resume",
});

describe("MemoryQueueDriver", () => {
  let driver: MemoryQueueDriver;
  beforeEach(async () => {
    driver = new MemoryQueueDriver();
    await driver.ensureQueues([{ queueName: "work" }]);
  });
  afterEach(() => driver.close());

  it("delivers a published message to a subscriber", async () => {
    const received: WorkflowMessage[] = [];
    await driver.subscribe("work", async (m) => { received.push(m); });
    await driver.publish("work", msg(1));
    await driver.drain();
    expect(received).toHaveLength(1);
    expect(received[0].runId).toBe(1);
  });

  it("holds a delayed message until its delay elapses", async () => {
    const received: WorkflowMessage[] = [];
    await driver.subscribe("work", async (m) => { received.push(m); });
    await driver.publish("work", msg(2), { delaySeconds: 5 });
    await driver.drain();
    expect(received).toHaveLength(0);

    driver.advanceTime(5000);
    await driver.drain();
    expect(received).toHaveLength(1);
  });

  it("stops delivering after unsubscribe", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });
    await stop();
    await driver.publish("work", msg(3));
    await driver.drain();
    expect(received).toHaveLength(0);
  });

  it("redelivers a message whose handler threw", async () => {
    let attempts = 0;
    await driver.subscribe("work", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("handler blew up");
    });
    await driver.publish("work", msg(4));
    await driver.drain();
    await driver.drain();
    expect(attempts).toBe(2);
  });

  it("reports a finite max delay", () => {
    expect(driver.maxDelaySeconds).toBeGreaterThan(0);
  });
});
```

The redelivery test pins at-least-once semantics: a handler that throws must not lose the message. Every driver in this plan is tested against that expectation.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @wfe/core -- queue`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the types**

`packages/core/src/queue/types.ts`:

```typescript
/** The envelope every driver carries. Kept small and JSON-serialisable. */
export interface WorkflowMessage {
  tenantId: string;
  runId: number;
  stepNumber: number;
  /** `resume` continues a suspended step; `callback` carries an external reply. */
  kind: "resume" | "callback";
  /** Payload for a callback; becomes the step's `body`. */
  body?: unknown;
  correlationId?: string;
  /** Incremented by core when chaining a delay longer than the driver allows. */
  attempt?: number;
}

export interface QueueDefinition {
  queueName: string;
  /** Default delay applied to every message on this queue, when a driver supports it. */
  delaySeconds?: number;
}

export type Unsubscribe = () => Promise<void>;

export interface QueueDriver {
  readonly name: string;
  /**
   * Largest delay this driver can apply to a single message. Core chains
   * re-enqueues for anything longer, so a driver never has to.
   */
  readonly maxDelaySeconds: number;
  ensureQueues(defs: QueueDefinition[]): Promise<void>;
  publish(queue: string, msg: WorkflowMessage, opts?: { delaySeconds?: number }): Promise<void>;
  /**
   * Delivery is at-least-once: a handler that throws must leave the message
   * for redelivery, and a handler that returns must consume it.
   */
  subscribe(queue: string, handler: (msg: WorkflowMessage) => Promise<void>): Promise<Unsubscribe>;
  close(): Promise<void>;
}

export interface QueueDriverOptions {
  url?: string;
  prefix?: string;
  region?: string;
  [key: string]: unknown;
}

export type QueueDriverFactory = (options: QueueDriverOptions) => QueueDriver;
```

- [ ] **Step 4: Write the queue names**

`packages/core/src/queue/names.ts`:

```typescript
/** Queue that carries delayed resume messages back to the engine. */
export const DELAY_QUEUE = "wfe-delay";
/** Queue that carries external workers' replies back to the engine. */
export const RESPONSE_QUEUE = "wfe-response";

/** Request queue for an external service named in a step definition. */
export function serviceQueueName(service: string): string {
  return `wfe-service-${service}`;
}
```

- [ ] **Step 5: Write the registry**

`packages/core/src/queue/registry.ts`:

```typescript
import { WfeError } from "../errors";
import { MemoryQueueDriver } from "./memory-driver";
import { QueueDriver, QueueDriverFactory, QueueDriverOptions } from "./types";

const factories = new Map<string, QueueDriverFactory>();

export function registerQueueDriver(name: string, factory: QueueDriverFactory): void {
  if (factories.has(name)) {
    throw new WfeError(`Queue driver "${name}" is already registered`, {
      statusCode: 409, code: "QUEUE_DRIVER_DUPLICATE",
    });
  }
  factories.set(name, factory);
}

export function createQueueDriver(name: string, options: QueueDriverOptions): QueueDriver {
  const factory = factories.get(name);
  if (!factory) {
    throw new WfeError(
      `Unknown queue driver "${name}". Registered drivers: ${[...factories.keys()].join(", ") || "none"}`,
      { statusCode: 400, code: "QUEUE_DRIVER_UNKNOWN" }
    );
  }
  return factory(options);
}

export function listQueueDrivers(): string[] {
  return [...factories.keys()];
}

registerQueueDriver("memory", () => new MemoryQueueDriver());
```

The rabbitmq and sqs drivers register themselves from their own modules in Tasks 6 and 7, so core never imports a broker client unless the operator selected that driver.

- [ ] **Step 6: Write the memory driver**

`packages/core/src/queue/memory-driver.ts`:

```typescript
import { QueueDefinition, QueueDriver, Unsubscribe, WorkflowMessage } from "./types";

interface Envelope {
  message: WorkflowMessage;
  visibleAt: number;
}

/**
 * In-process driver for tests and single-node development. Time is virtual:
 * `advanceTime` moves the clock so a delay test does not have to sleep, and
 * `drain` runs every message whose delay has elapsed.
 */
export class MemoryQueueDriver implements QueueDriver {
  readonly name = "memory";
  readonly maxDelaySeconds = 900;

  private readonly queues = new Map<string, Envelope[]>();
  private readonly handlers = new Map<string, (msg: WorkflowMessage) => Promise<void>>();
  private now = 0;

  async ensureQueues(defs: QueueDefinition[]): Promise<void> {
    for (const def of defs) {
      if (!this.queues.has(def.queueName)) {
        this.queues.set(def.queueName, []);
      }
    }
  }

  async publish(queue: string, msg: WorkflowMessage, opts?: { delaySeconds?: number }): Promise<void> {
    const envelopes = this.queues.get(queue) ?? [];
    envelopes.push({
      message: { ...msg },
      visibleAt: this.now + (opts?.delaySeconds ?? 0) * 1000,
    });
    this.queues.set(queue, envelopes);
  }

  async subscribe(queue: string, handler: (msg: WorkflowMessage) => Promise<void>): Promise<Unsubscribe> {
    this.handlers.set(queue, handler);
    return async () => {
      this.handlers.delete(queue);
    };
  }

  /** Virtual clock: move time forward so delayed messages become visible. */
  advanceTime(ms: number): void {
    this.now += ms;
  }

  /**
   * Delivers every currently-visible message once. A handler that throws leaves
   * its message queued for the next drain — at-least-once, as the interface says.
   */
  async drain(): Promise<void> {
    for (const [queue, envelopes] of this.queues) {
      const handler = this.handlers.get(queue);
      if (!handler) continue;

      const ready = envelopes.filter((e) => e.visibleAt <= this.now);
      const notReady = envelopes.filter((e) => e.visibleAt > this.now);
      const failed: Envelope[] = [];

      for (const envelope of ready) {
        try {
          await handler(envelope.message);
        } catch {
          failed.push(envelope);
        }
      }
      this.queues.set(queue, [...notReady, ...failed]);
    }
  }

  /** Messages currently queued on a queue, for assertions in tests. */
  pending(queue: string): WorkflowMessage[] {
    return (this.queues.get(queue) ?? []).map((e) => e.message);
  }

  async close(): Promise<void> {
    this.queues.clear();
    this.handlers.clear();
  }
}
```

- [ ] **Step 7: Run tests**

Run: `npm test -w @wfe/core -- queue`
Expected: PASS — 9 tests.

- [ ] **Step 8: Commit**

```bash
git add packages/core
git commit -m "feat(core): add queue driver contract, registry and in-memory driver"
```

---

### Task 3: Schema evolution — run versioning and step tenancy

**Files:**
- Create: `packages/core/src/db/migrations/0002-queue-support.ts`
- Modify: `packages/core/src/entities/workflow-run.ts`, `packages/core/src/entities/step-run.ts`, `packages/core/src/db/db-context.ts` (register the migration), `packages/core/src/engine/workflow-manager.ts` (set `tenantId` on new step rows)
- Modify: `packages/core/src/repositories/run-repository.ts`
- Test: `packages/core/test/db/concurrency.test.ts`, and additions to `packages/core/test/db/persistence.test.ts`

**Interfaces:**
- Consumes: Phase 1 entities and `RunRepository`.
- Produces: `WorkflowRun.revision` (`@VersionColumn`); `StepRun.tenantId`; `RunRepository.saveChecked(run): Promise<WorkflowRun>` throwing `WfeError` code `RUN_CONFLICT` (409) on a stale write; migration `QueueSupport0002`. Tasks 4, 5 and 8 use `saveChecked` on every path a queue consumer can reach.

**Naming:** the optimistic-lock counter is `revision`, not `version`. `WorkflowRun.version` already exists as a `varchar(50)` holding the workflow *definition's* version, is read by the executor to resolve the definition on resume, and is declared as `version: string` on `WorkflowRunLike` in the SDK. Reusing the name would collide in Postgres, in TypeScript, and in the SDK contract.

**Why now:** at-least-once delivery means two consumers can receive the same resume message and both pass the Phase 1 guards, because both read the same `currentStep` before either writes. TypeORM's `save()` is a blind full-row UPDATE, so the loser silently overwrites the winner — the same mechanism that lost `cancel()` in Phase 1. A version column turns that into a loud 409 the consumer can discard. `step_run.tenant_id` lands in the same migration because Plan 3's `GET /steps/next` claim path needs a tenant-scoped index and adding it later is a second migration over a bigger table.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/db/concurrency.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { WorkflowRun } from "../../src/entities/workflow-run";
import { WfeError } from "../../src/errors";
import { RunRepository } from "../../src/repositories/run-repository";

jest.setTimeout(120000);

describe("optimistic concurrency", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let runs: RunRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    db = new DbContext({ dbUrl: container.getConnectionUri() });
    await db.runMigrations();
    runs = new RunRepository(db);
  });

  afterAll(async () => {
    await db.close();
    await container.stop();
  });

  async function newRun(): Promise<WorkflowRun> {
    const run = new WorkflowRun();
    run.tenantId = "default";
    run.name = "conc";
    run.version = "1.0.0";
    run.currentStep = 0;
    run.status = WorkflowStatus.RUNNING;
    run.inputs = {};
    run.outputs = {};
    run.state = {};
    return runs.save(run);
  }

  it("starts a new run at revision 1", async () => {
    const saved = await newRun();
    expect(saved.revision).toBe(1);
  });

  it("increments the revision on each save", async () => {
    const saved = await newRun();
    saved.status = WorkflowStatus.WAITING;
    const again = await runs.saveChecked(saved);
    expect(again.revision).toBe(2);
  });

  it("rejects a stale write with RUN_CONFLICT", async () => {
    const saved = await newRun();

    // Two consumers load the same row — the shape at-least-once delivery produces.
    const a = await runs.findById("default", saved.id!);
    const b = await runs.findById("default", saved.id!);

    a!.status = WorkflowStatus.COMPLETE;
    await runs.saveChecked(a!);

    b!.status = WorkflowStatus.FAILED;
    await expect(runs.saveChecked(b!)).rejects.toMatchObject({
      code: "RUN_CONFLICT", statusCode: 409,
    });
  });

  it("leaves the winner's value in place after a conflict", async () => {
    const saved = await newRun();
    const a = await runs.findById("default", saved.id!);
    const b = await runs.findById("default", saved.id!);

    a!.status = WorkflowStatus.COMPLETE;
    await runs.saveChecked(a!);
    b!.status = WorkflowStatus.FAILED;
    await runs.saveChecked(b!).catch((err) => expect(err).toBeInstanceOf(WfeError));

    const reloaded = await runs.findById("default", saved.id!);
    expect(reloaded!.status).toBe(WorkflowStatus.COMPLETE);
  });
});
```

Add to `packages/core/test/db/persistence.test.ts`:

```typescript
  it("stamps tenantId onto cascaded step rows", async () => {
    const saved = await saveRun();
    const ds = await db.getDataSource();
    const rows = await ds.query("SELECT tenant_id FROM step_run WHERE run_id = $1", [saved.id]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { tenant_id: string }) => r.tenant_id === "default")).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @wfe/core -- concurrency`
Expected: FAIL — `saveChecked` is not a function, and `version` is undefined.

- [ ] **Step 3: Write the migration**

`packages/core/src/db/migrations/0002-queue-support.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class QueueSupport0002 implements MigrationInterface {
  name = "QueueSupport1788800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Optimistic concurrency: at-least-once delivery lets two consumers load
    // the same run and both pass the resume guards. Without a version, the
    // loser's blind full-row UPDATE silently overwrites the winner.
    await queryRunner.query(`ALTER TABLE workflow_run ADD COLUMN revision integer NOT NULL DEFAULT 1`);

    // step_run needs its own tenant for the tenant-scoped claim query the REST
    // API will run; joining to workflow_run for it would defeat the index.
    await queryRunner.query(`ALTER TABLE step_run ADD COLUMN tenant_id varchar(64) NOT NULL DEFAULT 'default'`);
    await queryRunner.query(
      `UPDATE step_run SET tenant_id = wr.tenant_id FROM workflow_run wr WHERE step_run.run_id = wr.id`
    );

    await queryRunner.query(`DROP INDEX IF EXISTS idx_step_run_claim`);
    await queryRunner.query(
      `CREATE INDEX idx_step_run_claim ON step_run (tenant_id, status, external_service_name, priority)`
    );
    await queryRunner.query(
      `CREATE INDEX idx_step_run_correlation ON step_run (tenant_id, remote_task_status) WHERE remote_task_status IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_step_run_correlation`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_step_run_claim`);
    await queryRunner.query(`CREATE INDEX idx_step_run_claim ON step_run (status, external_service_name, priority)`);
    await queryRunner.query(`ALTER TABLE step_run DROP COLUMN tenant_id`);
    await queryRunner.query(`ALTER TABLE workflow_run DROP COLUMN revision`);
  }
}
```

The `UPDATE ... FROM` backfill matters: the column is `NOT NULL DEFAULT 'default'`, so existing rows would otherwise all claim the default tenant regardless of which tenant's run they belong to.

- [ ] **Step 4: Update the entities and register the migration**

In `packages/core/src/entities/workflow-run.ts`, add the import and the column:

```typescript
import { VersionColumn } from "typeorm";

  /**
   * Optimistic-lock counter incremented by TypeORM on every save; a stale value
   * makes the UPDATE match zero rows. Named `revision`, NOT `version`, because
   * `version` on this entity already holds the workflow definition's version
   * string and is load-bearing in the executor and the SDK's WorkflowRunLike.
   */
  @VersionColumn()
  revision!: number;
```

In `packages/core/src/entities/step-run.ts`:

```typescript
  @Column({ type: "varchar", length: 64, nullable: false, default: "default" })
  tenantId!: string;
```

In `packages/core/src/db/db-context.ts`, import `QueueSupport0002` and add it to the `migrations` array after `Init0001`.

In `packages/core/src/engine/workflow-manager.ts`, inside the step materialization in `startWorkflow`, set `step.tenantId = input.tenantId;` alongside the other step fields.

- [ ] **Step 5: Add `saveChecked` to the repository**

In `packages/core/src/repositories/run-repository.ts`:

```typescript
import { OptimisticLockVersionMismatchError } from "typeorm";
import { WfeError } from "../errors";

  /**
   * Saves a run, failing loudly when another writer has advanced it since this
   * entity was loaded. Use this on every path a queue consumer can reach: with
   * at-least-once delivery two consumers can hold the same run, and a blind
   * save would let the loser overwrite the winner.
   */
  async saveChecked(run: WorkflowRun): Promise<WorkflowRun> {
    const ds = await this.db.getDataSource();
    try {
      return await ds.getRepository(WorkflowRun).save(run);
    } catch (err) {
      if (err instanceof OptimisticLockVersionMismatchError) {
        throw new WfeError(
          `Workflow run ${run.id} was modified by another writer; discarding this update`,
          { statusCode: 409, code: "RUN_CONFLICT", cause: err as Error }
        );
      }
      throw err;
    }
  }
```

- [ ] **Step 6: Run the tests**

Run: `npm test -w @wfe/core -- "concurrency|persistence"`
Expected: PASS — 4 concurrency tests plus the existing persistence tests and the new tenant assertion.

If TypeORM does not raise `OptimisticLockVersionMismatchError` for your save shape, do not weaken the test: report what it raised instead. The behaviour is the point of the task.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core
git commit -m "feat(core): add run version column, step tenancy and checked saves"
```

---

### Task 4: Executor–queue integration and delay chaining

**Files:**
- Create: `packages/core/src/engine/suspension.ts`
- Modify: `packages/core/src/engine/workflow-manager.ts` (`EngineDeps.queue`), `packages/core/src/engine/run-executor.ts`
- Test: `packages/core/test/engine/queue-integration.test.ts`

**Interfaces:**
- Consumes: `QueueDriver`, `WorkflowMessage`, `DELAY_QUEUE`, `serviceQueueName`, `StepSuspension`, `saveChecked`.
- Produces: `EngineDeps.queue?: QueueDriver`; `RunExecutor.resume(msg: WorkflowMessage): Promise<WorkflowRun>`; `planSuspension(suspend, driverMax): { queue: string; delaySeconds: number; remaining: number }` in `suspension.ts`. Tasks 5, 8 and 9 consume `resume`.

**Why core owns the enqueue:** spec §8 says "delays exceeding a driver's native limit are chained by core, so drivers stay simple and a 30-day delay works everywhere." Chaining requires the engine to publish the next hop itself, so `run()` publishes rather than returning a delay for the caller to act on.

**The chaining rule:** if the requested delay exceeds `driver.maxDelaySeconds`, publish with `maxDelaySeconds` and carry the remainder in the message. On resume, if a remainder is left, re-publish rather than executing. `planSuspension` is a pure function so the arithmetic is unit-testable without a broker.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/engine/queue-integration.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  BaseStep, RunStepResponse, StepContext, WorkflowDefinitionStatus, WorkflowStatus,
} from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { RunExecutor } from "../../src/engine/run-executor";
import { planSuspension } from "../../src/engine/suspension";
import { ExpressionEvaluator } from "../../src/expression/evaluator";
import { MemoryQueueDriver } from "../../src/queue/memory-driver";
import { DELAY_QUEUE } from "../../src/queue/names";
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

class SleepStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (ctx.isResume) {
      ctx.step.status = WorkflowStatus.COMPLETE;
      return { stepState: ctx.step };
    }
    ctx.step.status = WorkflowStatus.WAITING;
    return { stepState: ctx.step, suspend: { kind: "delay", delaySeconds: 60 } };
  }
}

describe("planSuspension", () => {
  it("passes a short delay through whole", () => {
    expect(planSuspension({ kind: "delay", delaySeconds: 60 }, 900)).toEqual({
      queue: DELAY_QUEUE, delaySeconds: 60, remaining: 0,
    });
  });

  it("caps a long delay at the driver maximum and carries the remainder", () => {
    expect(planSuspension({ kind: "delay", delaySeconds: 2000 }, 900)).toEqual({
      queue: DELAY_QUEUE, delaySeconds: 900, remaining: 1100,
    });
  });

  it("caps a 30-day delay without losing time", () => {
    const thirtyDays = 30 * 24 * 60 * 60;
    const plan = planSuspension({ kind: "delay", delaySeconds: thirtyDays }, 900);
    expect(plan.delaySeconds + plan.remaining).toBe(thirtyDays);
  });

  it("routes an await-callback suspension with no delay", () => {
    const plan = planSuspension({ kind: "awaitCallback", queue: "billing" }, 900);
    expect(plan.delaySeconds).toBe(0);
  });
});

describe("executor queue integration", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let queue: MemoryQueueDriver;
  let executor: RunExecutor;
  let runs: RunRepository;
  let evaluator: ExpressionEvaluator;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    registry.register({ type: "test.counting", version: "1.0.0", factory: (p) => new CountingStep(p) });
    registry.register({ type: "test.sleep", version: "1.0.0", factory: (p) => new SleepStep(p) });

    queue = new MemoryQueueDriver();
    await queue.ensureQueues([{ queueName: DELAY_QUEUE }]);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    executor = new RunExecutor({ config, db, registry, evaluator, queue });
    runs = new RunRepository(db);
  });

  afterAll(async () => {
    evaluator.dispose();
    await queue.close();
    await db.close();
    await container.stop();
  });

  beforeEach(() => { runCount = 0; });

  async function startRun(name: string, types: string[]): Promise<number> {
    await new DefinitionRepository(db).create({
      tenantId: "default", name, version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: {
        steps: types.map((stepType, i) => ({
          stepName: `S${i}`, stepVersion: "1.0.0", stepType, stepInputs: [],
        })),
      } as never,
    });
    return executor.startWorkflow({ tenantId: "default", name, version: "1.0.0", inputs: {} });
  }

  it("publishes a resume message when a step suspends", async () => {
    const runId = await startRun("q-1", ["test.sleep", "test.counting"]);
    const run = await executor.start("default", runId);

    expect(run.status).toBe(WorkflowStatus.WAITING);
    const pending = queue.pending(DELAY_QUEUE);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ tenantId: "default", runId, stepNumber: 0, kind: "resume" });
    expect(runCount).toBe(0);
  });

  it("resumes the suspended step and finishes the run", async () => {
    const runId = await startRun("q-2", ["test.sleep", "test.counting"]);
    await executor.start("default", runId);
    const msg = queue.pending(DELAY_QUEUE).find((m) => m.runId === runId)!;

    const resumed = await executor.resume(msg);
    expect(resumed.status).toBe(WorkflowStatus.COMPLETE);
    expect(runCount).toBe(1);
  });

  it("discards a resume message for a cancelled run", async () => {
    const runId = await startRun("q-3", ["test.sleep", "test.counting"]);
    await executor.start("default", runId);
    const msg = queue.pending(DELAY_QUEUE).find((m) => m.runId === runId)!;
    await executor.cancel("default", runId);

    const after = await executor.resume(msg);
    expect(after.status).toBe(WorkflowStatus.CANCELLED);
    expect(runCount).toBe(0);
  });

  it("runs without a queue when none is configured", async () => {
    const noQueue = new RunExecutor({
      config: { dbUrl: container.getConnectionUri() }, db,
      registry: (executor as unknown as { registry: StepRegistry }).registry,
      evaluator,
    });
    const runId = await startRun("q-4", ["test.counting"]);
    const run = await noQueue.start("default", runId);
    expect(run.status).toBe(WorkflowStatus.COMPLETE);
  });

  it("fails a suspending run with an actionable error when no queue is configured", async () => {
    const noQueue = new RunExecutor({
      config: { dbUrl: container.getConnectionUri() }, db,
      registry: (executor as unknown as { registry: StepRegistry }).registry,
      evaluator,
    });
    const runId = await startRun("q-5", ["test.sleep"]);
    await expect(noQueue.start("default", runId)).rejects.toThrow(/queue/i);
  });
});
```

The last two tests pin an important boundary: a workflow with no suspending steps must still run with no queue configured (Phase 1 behaviour, and the example in the README relies on it), while a workflow that actually suspends must fail loudly rather than silently parking forever.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @wfe/core -- queue-integration`
Expected: FAIL — `planSuspension` and `resume` do not exist, and `EngineDeps` has no `queue`.

- [ ] **Step 3: Write the suspension planner**

`packages/core/src/engine/suspension.ts`:

```typescript
import { StepSuspension } from "@wfe/sdk";
import { DELAY_QUEUE, serviceQueueName } from "../queue/names";

export interface SuspensionPlan {
  queue: string;
  /** Delay to apply to this hop, never more than the driver allows. */
  delaySeconds: number;
  /** Seconds still owed after this hop; > 0 means core must chain another. */
  remaining: number;
}

/**
 * Decides where a suspension's resume message goes and how long it waits.
 * Pure, so the chaining arithmetic is testable without a broker.
 */
export function planSuspension(suspend: StepSuspension, driverMaxSeconds: number): SuspensionPlan {
  if (suspend.kind === "awaitCallback") {
    return {
      queue: suspend.queue ? serviceQueueName(suspend.queue) : DELAY_QUEUE,
      delaySeconds: 0,
      remaining: 0,
    };
  }

  const requested = Math.max(0, Math.floor(suspend.delaySeconds));
  const thisHop = Math.min(requested, driverMaxSeconds);
  return { queue: DELAY_QUEUE, delaySeconds: thisHop, remaining: requested - thisHop };
}
```

- [ ] **Step 4: Add the queue to `EngineDeps`**

In `packages/core/src/engine/workflow-manager.ts`, add `queue?: QueueDriver;` to `EngineDeps`, a `protected readonly queue?: QueueDriver;` field, and assign it in the constructor. Import the type from `../queue/types`.

- [ ] **Step 5: Publish on suspension and add `resume`**

In `packages/core/src/engine/run-executor.ts`, replace the suspension branch inside `run()`:

```typescript
      if (result.suspend) {
        run.status = WorkflowStatus.WAITING;
        const saved = await this.runs.saveChecked(run);
        await this.publishSuspension(saved, nextStep, result.suspend, 0);
        return saved;
      }
```

and add:

```typescript
  /**
   * Publishes the message that will resume this step. Core owns this rather
   * than the caller so a delay longer than the driver's limit can be chained
   * transparently — spec §8.
   */
  protected async publishSuspension(
    run: WorkflowRun, stepNumber: number, suspend: StepSuspension, carried: number
  ): Promise<void> {
    if (!this.queue) {
      throw new WfeError(
        `Step ${stepNumber} of run ${run.id} suspended, but no queue driver is configured to resume it`,
        { statusCode: 500, code: "QUEUE_NOT_CONFIGURED" }
      );
    }

    const effective: StepSuspension =
      carried > 0 ? { kind: "delay", delaySeconds: carried } : suspend;
    const plan = planSuspension(effective, this.queue.maxDelaySeconds);

    await this.queue.publish(
      plan.queue,
      {
        tenantId: run.tenantId,
        runId: run.id!,
        stepNumber,
        kind: "resume",
        correlationId: effective.kind === "awaitCallback" ? effective.correlationId : undefined,
        attempt: plan.remaining,
      },
      { delaySeconds: plan.delaySeconds }
    );
  }

  /**
   * Entry point for a queue consumer. Chains the next hop when the message
   * still carries unspent delay, otherwise re-enters the advance loop — where
   * the Phase 1 guards discard duplicates and stale deliveries.
   */
  async resume(msg: WorkflowMessage): Promise<WorkflowRun> {
    if (msg.attempt && msg.attempt > 0) {
      const run = await this.runs.findById(msg.tenantId, msg.runId);
      if (!run) {
        throw new WfeError(`Cannot locate workflow run ${msg.runId}`, {
          statusCode: 404, code: "RUN_NOT_FOUND",
        });
      }
      if (isResumeBlocked(run.status)) {
        this.log.warn("Discarding chained delay for a run in a blocked state", {
          runId: msg.runId, status: run.status,
        });
        return run;
      }
      await this.publishSuspension(
        run, msg.stepNumber, { kind: "delay", delaySeconds: msg.attempt }, msg.attempt
      );
      return run;
    }

    return this.run(msg.tenantId, msg.runId, msg.stepNumber, msg.body);
  }
```

Import `StepSuspension` from `@wfe/sdk`, `WorkflowMessage` from `../queue/types`, and `planSuspension` from `./suspension`.

Also replace the remaining `this.runs.save(run)` calls inside `run()` and `executeStep`'s success path with `this.runs.saveChecked(run)`, so a concurrent writer produces a 409 rather than a silent overwrite. Leave `cancel` on `save` — an operator cancelling should win over an in-flight loop, and the loop's status re-read is what observes it.

- [ ] **Step 6: Run tests**

Run: `npm test -w @wfe/core -- queue-integration`
Expected: PASS — 4 planner tests, 5 integration tests.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core
git commit -m "feat(core): publish resume messages on suspension with delay chaining"
```

---

### Task 5: Callback resumption and the external-task step

**Files:**
- Create: `packages/core/src/steps/external-task-step.ts`
- Modify: `packages/core/src/registry/step-registry.ts` (register `core.externalTask`), `packages/core/src/engine/run-executor.ts` (`callback`)
- Test: `packages/core/test/engine/callback.test.ts`

**Interfaces:**
- Consumes: Task 1's `awaitCallback` suspension, Task 4's `publishSuspension`/`resume`, `serviceQueueName`.
- Produces: `RunExecutor.callback(tenantId, runId, stepNumber, body): Promise<WorkflowRun>`; `ExternalTaskStep` registered as `core.externalTask`. Task 8's response-queue subscription calls `callback`; Plan 3's `PUT /runs/:id/callback` calls it too.

**How an external step works:** on first entry (`isResume === false`) it publishes a request onto the service's queue and returns an `awaitCallback` suspension, so the run parks. An external worker does the work and replies on the response queue. The worker runtime (Task 8) turns that reply into `callback(...)`, which re-enters the step with `isResume === true` and the reply as `ctx.body`, and the step completes.

The step reads `externalServiceName` from its own definition — Phase 1 already materialises that field onto `step_run` but nothing has read it until now.

- [ ] **Step 1: Write the failing test**

`packages/core/test/engine/callback.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { RunExecutor } from "../../src/engine/run-executor";
import { ExpressionEvaluator } from "../../src/expression/evaluator";
import { MemoryQueueDriver } from "../../src/queue/memory-driver";
import { DELAY_QUEUE, serviceQueueName } from "../../src/queue/names";
import { StepRegistry, registerBuiltInSteps } from "../../src/registry/step-registry";
import { DefinitionRepository } from "../../src/repositories/definition-repository";
import { RunRepository } from "../../src/repositories/run-repository";

jest.setTimeout(120000);

describe("callback resumption", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let queue: MemoryQueueDriver;
  let executor: RunExecutor;
  let runs: RunRepository;
  let evaluator: ExpressionEvaluator;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);

    queue = new MemoryQueueDriver();
    await queue.ensureQueues([
      { queueName: DELAY_QUEUE }, { queueName: serviceQueueName("billing") },
    ]);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    executor = new RunExecutor({ config, db, registry, evaluator, queue });
    runs = new RunRepository(db);
  });

  afterAll(async () => {
    evaluator.dispose();
    await queue.close();
    await db.close();
    await container.stop();
  });

  async function startExternalRun(name: string): Promise<number> {
    await new DefinitionRepository(db).create({
      tenantId: "default", name, version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: {
        steps: [
          {
            stepName: "Charge", stepVersion: "1.0.0", stepType: "core.externalTask",
            externalServiceName: "billing",
            stepInputs: [
              { targetFieldName: "amount", modelEvaluationExpression: "Number(500)" },
            ],
          },
          {
            stepName: "Record", stepVersion: "1.0.0", stepType: "core.transform",
            stepInputs: [
              {
                targetFieldName: "receipt",
                modelEvaluationExpression: "workflowState.stepStates.Charge.outputs.receiptId",
              },
            ],
          },
        ],
      } as never,
    });
    return executor.startWorkflow({ tenantId: "default", name, version: "1.0.0", inputs: {} });
  }

  it("dispatches a request to the service queue and parks the run", async () => {
    const runId = await startExternalRun("cb-1");
    const run = await executor.start("default", runId);

    expect(run.status).toBe(WorkflowStatus.WAITING);
    const dispatched = queue.pending(serviceQueueName("billing"));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ runId, stepNumber: 0 });
    expect(run.stepRuns![0].status).toBe(WorkflowStatus.WAITING);
  });

  it("resumes the parked step with the callback payload and finishes the run", async () => {
    const runId = await startExternalRun("cb-2");
    await executor.start("default", runId);

    const finished = await executor.callback("default", runId, 0, { receiptId: "rcpt-9" });

    expect(finished.status).toBe(WorkflowStatus.COMPLETE);
    expect(finished.stepRuns![0].outputs).toMatchObject({ receiptId: "rcpt-9" });
    expect(finished.stepRuns![1].inputs).toMatchObject({ receipt: "rcpt-9" });
  });

  it("rejects a callback for a step the run is not parked on", async () => {
    const runId = await startExternalRun("cb-3");
    await executor.start("default", runId);

    await expect(executor.callback("default", runId, 1, {})).rejects.toMatchObject({
      code: "CALLBACK_STEP_MISMATCH",
    });
  });

  it("rejects a callback for a cancelled run", async () => {
    const runId = await startExternalRun("cb-4");
    await executor.start("default", runId);
    await executor.cancel("default", runId);

    const run = await executor.callback("default", runId, 0, { receiptId: "x" });
    expect(run.status).toBe(WorkflowStatus.CANCELLED);
  });

  it("does not re-dispatch the request when resumed", async () => {
    const runId = await startExternalRun("cb-5");
    await executor.start("default", runId);
    const before = queue.pending(serviceQueueName("billing")).length;

    await executor.callback("default", runId, 0, { receiptId: "rcpt-1" });

    expect(queue.pending(serviceQueueName("billing"))).toHaveLength(before);
  });
});
```

The last test is the one that catches a wrong `isResume`: if the step re-dispatches on resumption, the external service does the work twice.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @wfe/core -- callback`
Expected: FAIL — `core.externalTask` is not registered and `callback` does not exist.

- [ ] **Step 3: Write the external-task step**

`packages/core/src/steps/external-task-step.ts`:

```typescript
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

/**
 * Dispatches its inputs to an external service's queue and parks the run until
 * that service replies. On resumption the reply payload arrives as `ctx.body`
 * and becomes the step's outputs.
 *
 * The service name comes from the step definition's `externalServiceName`,
 * surfaced on the step row the executor hands to the context.
 */
export class ExternalTaskStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (ctx.isResume) {
      ctx.step.outputs = (ctx.body as Record<string, unknown>) ?? {};
      ctx.step.status = WorkflowStatus.COMPLETE;
      return { stepState: ctx.step };
    }

    ctx.step.status = WorkflowStatus.WAITING;
    ctx.step.message = `Awaiting reply from "${ctx.step.externalServiceName ?? "unnamed service"}"`;
    return {
      stepState: ctx.step,
      suspend: {
        kind: "awaitCallback",
        queue: ctx.step.externalServiceName,
        correlationId: `${ctx.run.id}:${ctx.stepNumber}`,
      },
    };
  }
}
```

Register it in `registerBuiltInSteps`:

```typescript
  registry.register({
    type: "core.externalTask",
    version: "1.0.0",
    description: "Dispatches to an external service queue and waits for its callback.",
    factory: (params) => new ExternalTaskStep(params),
  });
```

Update the registry test's `list()` assertion to expect all three built-in types.

- [ ] **Step 4: Add `callback` to the executor**

In `packages/core/src/engine/run-executor.ts`:

```typescript
  /**
   * Applies an external worker's reply to a parked step and resumes the run.
   * Guarded the same way as any resume: at-least-once delivery means a reply
   * can arrive twice, or late, or for a run that has since been cancelled.
   */
  async callback(
    tenantId: string, runId: number, stepNumber: number, body: unknown
  ): Promise<WorkflowRun> {
    const run = await this.runs.findById(tenantId, runId);
    if (!run) {
      throw new WfeError(`Cannot locate workflow run ${runId}`, {
        statusCode: 404, code: "RUN_NOT_FOUND",
      });
    }

    if (isResumeBlocked(run.status)) {
      this.log.warn("Discarding callback for a run in a blocked state", {
        runId, stepNumber, status: run.status,
      });
      return run;
    }

    if (run.currentStep !== stepNumber) {
      throw new WfeError(
        `Run ${runId} is on step ${run.currentStep}, not ${stepNumber}; discarding callback`,
        { statusCode: 409, code: "CALLBACK_STEP_MISMATCH" }
      );
    }

    return this.run(tenantId, runId, stepNumber, body);
  }
```

Note the deliberate asymmetry: a blocked run returns quietly (the reply is simply too late and nothing is wrong), while a step mismatch throws, because that indicates the caller or the correlation is wrong and swallowing it would hide a real bug.

`isResume` in `executeStep` is derived from the step row being `WAITING` (Task 1), so a callback re-entry sets it correctly and the dispatch branch is skipped. The `body` is passed through to `ctx.body` independently — a delay resume has no body, and that must not change how the step reads its own re-entry.

- [ ] **Step 5: Run tests**

Run: `npm test -w @wfe/core -- callback`
Expected: PASS — 5 tests.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test`

```bash
git add packages/core
git commit -m "feat(core): add callback resumption and the core.externalTask step"
```

---

### Task 6: RabbitMQ driver

**Files:**
- Create: `packages/core/src/queue/rabbitmq-driver.ts`
- Modify: `packages/core/package.json` (add `amqplib`, dev `@types/amqplib`, dev `@testcontainers/rabbitmq`)
- Test: `packages/core/test/queue/rabbitmq-driver.test.ts`

**Interfaces:**
- Consumes: `QueueDriver`, `WorkflowMessage`, `registerQueueDriver`.
- Produces: `RabbitMqQueueDriver` registered as `"rabbitmq"`, taking `{ url }`.

**Delay strategy:** RabbitMQ has no native per-message delay. Publish a delayed message to a per-bucket holding queue declared with `x-message-ttl` and a dead-letter exchange pointing back at the work queue; when the TTL expires the broker moves it. Bucketing matters because a TTL queue is FIFO — a message with a short TTL sitting behind one with a long TTL waits for the long one (head-of-line blocking). Round each delay up to a bucket (10s, 60s, 300s, 900s) and declare one holding queue per bucket, so a message only ever queues behind others with the same TTL.

`maxDelaySeconds` is 900 to match the largest bucket; core chains anything longer.

- [ ] **Step 1: Write the failing test**

`packages/core/test/queue/rabbitmq-driver.test.ts`:

```typescript
import { RabbitMQContainer, StartedRabbitMQContainer } from "@testcontainers/rabbitmq";
import { RabbitMqQueueDriver } from "../../src/queue/rabbitmq-driver";
import { WorkflowMessage } from "../../src/queue/types";

jest.setTimeout(180000);

const msg = (runId: number): WorkflowMessage => ({
  tenantId: "default", runId, stepNumber: 0, kind: "resume",
});

/** Waits for a predicate, polling — brokers are asynchronous. */
async function eventually(check: () => boolean, timeoutMs = 20000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("condition not met within timeout");
}

describe("RabbitMqQueueDriver", () => {
  let container: StartedRabbitMQContainer;
  let driver: RabbitMqQueueDriver;

  beforeAll(async () => {
    container = await new RabbitMQContainer("rabbitmq:3.13-alpine").start();
    driver = new RabbitMqQueueDriver({ url: container.getAmqpUrl() });
    await driver.ensureQueues([{ queueName: "work" }]);
  });

  afterAll(async () => {
    await driver.close();
    await container.stop();
  });

  it("round-trips a message", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });

    await driver.publish("work", msg(1));
    await eventually(() => received.length === 1);
    expect(received[0].runId).toBe(1);

    await stop();
  });

  it("preserves every field of the envelope", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });

    await driver.publish("work", {
      tenantId: "t1", runId: 7, stepNumber: 3, kind: "callback",
      body: { receiptId: "r-1" }, correlationId: "7:3", attempt: 120,
    });
    await eventually(() => received.length === 1);
    expect(received[0]).toEqual({
      tenantId: "t1", runId: 7, stepNumber: 3, kind: "callback",
      body: { receiptId: "r-1" }, correlationId: "7:3", attempt: 120,
    });

    await stop();
  });

  it("holds a delayed message and delivers it after the delay", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });

    const publishedAt = Date.now();
    await driver.publish("work", msg(2), { delaySeconds: 3 });
    expect(received).toHaveLength(0);

    await eventually(() => received.length === 1, 30000);
    expect(Date.now() - publishedAt).toBeGreaterThanOrEqual(2500);

    await stop();
  });

  it("redelivers a message whose handler threw", async () => {
    let attempts = 0;
    const stop = await driver.subscribe("work", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("handler blew up");
    });

    await driver.publish("work", msg(3));
    await eventually(() => attempts >= 2, 30000);

    await stop();
  });

  it("stops delivering after unsubscribe", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });
    await stop();

    await driver.publish("work", msg(4));
    await new Promise((r) => setTimeout(r, 2000));
    expect(received).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- rabbitmq`
Expected: FAIL — module not found.

- [ ] **Step 3: Install dependencies**

```bash
npm install amqplib --workspace @wfe/core
npm install -D @types/amqplib @testcontainers/rabbitmq --workspace @wfe/core
```

- [ ] **Step 4: Implement the driver**

`packages/core/src/queue/rabbitmq-driver.ts`:

```typescript
import * as amqp from "amqplib";
import { registerQueueDriver } from "./registry";
import { QueueDefinition, QueueDriver, QueueDriverOptions, Unsubscribe, WorkflowMessage } from "./types";

const DELAY_EXCHANGE = "wfe-delay-exchange";
/** TTL buckets in seconds. A message only ever queues behind equal-TTL peers. */
const DELAY_BUCKETS = [10, 60, 300, 900];

export class RabbitMqQueueDriver implements QueueDriver {
  readonly name = "rabbitmq";
  readonly maxDelaySeconds = 900;

  private readonly url: string;
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;

  constructor(options: QueueDriverOptions) {
    if (!options.url) {
      throw new Error("rabbitmq queue driver requires a url");
    }
    this.url = options.url;
  }

  private async getChannel(): Promise<amqp.Channel> {
    if (!this.channel) {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(DELAY_EXCHANGE, "direct", { durable: true });
    }
    return this.channel;
  }

  async ensureQueues(defs: QueueDefinition[]): Promise<void> {
    const channel = await this.getChannel();
    for (const def of defs) {
      await channel.assertQueue(def.queueName, { durable: true });
      await channel.bindQueue(def.queueName, DELAY_EXCHANGE, def.queueName);

      // One holding queue per bucket per target: messages dead-letter back to
      // the work queue when their TTL expires.
      for (const bucket of DELAY_BUCKETS) {
        await channel.assertQueue(this.holdingQueue(def.queueName, bucket), {
          durable: true,
          messageTtl: bucket * 1000,
          deadLetterExchange: DELAY_EXCHANGE,
          deadLetterRoutingKey: def.queueName,
        });
      }
    }
  }

  private holdingQueue(queue: string, bucketSeconds: number): string {
    return `${queue}-delay-${bucketSeconds}`;
  }

  private bucketFor(delaySeconds: number): number {
    return DELAY_BUCKETS.find((b) => b >= delaySeconds) ?? DELAY_BUCKETS[DELAY_BUCKETS.length - 1];
  }

  async publish(queue: string, msg: WorkflowMessage, opts?: { delaySeconds?: number }): Promise<void> {
    const channel = await this.getChannel();
    const payload = Buffer.from(JSON.stringify(msg));
    const delay = opts?.delaySeconds ?? 0;

    if (delay <= 0) {
      channel.sendToQueue(queue, payload, { persistent: true });
      return;
    }

    channel.sendToQueue(this.holdingQueue(queue, this.bucketFor(delay)), payload, { persistent: true });
  }

  async subscribe(queue: string, handler: (msg: WorkflowMessage) => Promise<void>): Promise<Unsubscribe> {
    const channel = await this.getChannel();
    await channel.prefetch(1);

    const { consumerTag } = await channel.consume(queue, (raw) => {
      if (!raw) return;
      void (async () => {
        try {
          await handler(JSON.parse(raw.content.toString()) as WorkflowMessage);
          channel.ack(raw);
        } catch {
          // At-least-once: requeue so the message is redelivered rather than lost.
          channel.nack(raw, false, true);
        }
      })();
    });

    return async () => {
      await channel.cancel(consumerTag);
    };
  }

  async close(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
    this.channel = undefined;
    this.connection = undefined;
  }
}

registerQueueDriver("rabbitmq", (options) => new RabbitMqQueueDriver(options));
```

If `amqplib`'s current types name the connection type differently from `ChannelModel`, use whatever its `connect()` actually returns and say so in your report — do not cast to `any`.

- [ ] **Step 5: Run tests**

Run: `npm test -w @wfe/core -- rabbitmq`
Expected: PASS — 5 tests. The delay test takes several seconds by design.

- [ ] **Step 6: Commit**

```bash
git add packages/core package-lock.json
git commit -m "feat(core): add RabbitMQ queue driver with bucketed TTL delays"
```

---

### Task 7: SQS driver

**Files:**
- Create: `packages/core/src/queue/sqs-driver.ts`
- Modify: `packages/core/package.json` (add `@aws-sdk/client-sqs`, dev `@testcontainers/localstack`)
- Test: `packages/core/test/queue/sqs-driver.test.ts`

**Interfaces:**
- Consumes: `QueueDriver`, `WorkflowMessage`, `registerQueueDriver`.
- Produces: `SqsQueueDriver` registered as `"sqs"`, taking `{ region, prefix, endpoint? }`.

**Notes:** SQS has native `DelaySeconds` capped at 900, which is where `maxDelaySeconds = 900` comes from. Subscription is a long-poll loop: receive with `WaitTimeSeconds: 20`, handle, delete on success, leave undeleted on failure so the visibility timeout returns it. `endpoint` exists so the test can point at LocalStack; production omits it.

- [ ] **Step 1: Write the failing test**

`packages/core/test/queue/sqs-driver.test.ts`:

```typescript
import { LocalstackContainer, StartedLocalStackContainer } from "@testcontainers/localstack";
import { SqsQueueDriver } from "../../src/queue/sqs-driver";
import { WorkflowMessage } from "../../src/queue/types";

jest.setTimeout(180000);

const msg = (runId: number): WorkflowMessage => ({
  tenantId: "default", runId, stepNumber: 0, kind: "resume",
});

async function eventually(check: () => boolean, timeoutMs = 30000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("condition not met within timeout");
}

describe("SqsQueueDriver", () => {
  let container: StartedLocalStackContainer;
  let driver: SqsQueueDriver;

  beforeAll(async () => {
    container = await new LocalstackContainer("localstack/localstack:3").start();
    driver = new SqsQueueDriver({
      region: "us-east-1",
      prefix: "wfe-test",
      endpoint: container.getConnectionUri(),
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await driver.ensureQueues([{ queueName: "work" }]);
  });

  afterAll(async () => {
    await driver.close();
    await container.stop();
  });

  it("round-trips a message", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });

    await driver.publish("work", msg(1));
    await eventually(() => received.length >= 1);
    expect(received[0].runId).toBe(1);

    await stop();
  });

  it("preserves every field of the envelope", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });

    await driver.publish("work", {
      tenantId: "t1", runId: 9, stepNumber: 2, kind: "callback",
      body: { ok: true }, correlationId: "9:2", attempt: 30,
    });
    await eventually(() => received.length >= 1);
    expect(received[0]).toEqual({
      tenantId: "t1", runId: 9, stepNumber: 2, kind: "callback",
      body: { ok: true }, correlationId: "9:2", attempt: 30,
    });

    await stop();
  });

  it("applies a native delay", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });

    const publishedAt = Date.now();
    await driver.publish("work", msg(2), { delaySeconds: 3 });
    await eventually(() => received.some((m) => m.runId === 2), 40000);
    expect(Date.now() - publishedAt).toBeGreaterThanOrEqual(2500);

    await stop();
  });

  it("caps delay at the SQS maximum", () => {
    expect(driver.maxDelaySeconds).toBe(900);
  });

  it("redelivers a message whose handler threw", async () => {
    let attempts = 0;
    const stop = await driver.subscribe("work", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("handler blew up");
    });

    await driver.publish("work", msg(3));
    await eventually(() => attempts >= 2, 60000);

    await stop();
  });
});
```

The redelivery test depends on a short visibility timeout — set it low when creating the queue so the test does not wait 30 seconds.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- sqs`
Expected: FAIL — module not found.

- [ ] **Step 3: Install dependencies**

```bash
npm install @aws-sdk/client-sqs --workspace @wfe/core
npm install -D @testcontainers/localstack --workspace @wfe/core
```

- [ ] **Step 4: Implement the driver**

`packages/core/src/queue/sqs-driver.ts`:

```typescript
import {
  CreateQueueCommand, DeleteMessageCommand, GetQueueUrlCommand,
  ReceiveMessageCommand, SendMessageCommand, SQSClient,
} from "@aws-sdk/client-sqs";
import { registerQueueDriver } from "./registry";
import { QueueDefinition, QueueDriver, QueueDriverOptions, Unsubscribe, WorkflowMessage } from "./types";

export class SqsQueueDriver implements QueueDriver {
  readonly name = "sqs";
  /** SQS caps native per-message delay at 900s; core chains anything longer. */
  readonly maxDelaySeconds = 900;

  private readonly client: SQSClient;
  private readonly prefix: string;
  private readonly urls = new Map<string, string>();
  private stopped = false;

  constructor(options: QueueDriverOptions) {
    this.prefix = (options.prefix as string) ?? "wfe";
    this.client = new SQSClient({
      region: (options.region as string) ?? process.env.AWS_REGION,
      ...(options.endpoint ? { endpoint: options.endpoint as string } : {}),
      ...(options.credentials ? { credentials: options.credentials as never } : {}),
    });
  }

  private physicalName(queue: string): string {
    return `${this.prefix}-${queue}`;
  }

  async ensureQueues(defs: QueueDefinition[]): Promise<void> {
    for (const def of defs) {
      const name = this.physicalName(def.queueName);
      const created = await this.client.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: {
            MessageRetentionPeriod: "86400",
            // Short enough that a failed handler's message returns promptly.
            VisibilityTimeout: "10",
          },
        })
      );
      if (created.QueueUrl) {
        this.urls.set(def.queueName, created.QueueUrl);
      }
    }
  }

  private async urlFor(queue: string): Promise<string> {
    const cached = this.urls.get(queue);
    if (cached) return cached;
    const found = await this.client.send(
      new GetQueueUrlCommand({ QueueName: this.physicalName(queue) })
    );
    const url = found.QueueUrl!;
    this.urls.set(queue, url);
    return url;
  }

  async publish(queue: string, msg: WorkflowMessage, opts?: { delaySeconds?: number }): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.urlFor(queue),
        MessageBody: JSON.stringify(msg),
        DelaySeconds: Math.min(opts?.delaySeconds ?? 0, this.maxDelaySeconds),
      })
    );
  }

  async subscribe(queue: string, handler: (msg: WorkflowMessage) => Promise<void>): Promise<Unsubscribe> {
    const url = await this.urlFor(queue);
    let running = true;

    const loop = async (): Promise<void> => {
      while (running && !this.stopped) {
        const received = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: url, MaxNumberOfMessages: 1, WaitTimeSeconds: 5,
          })
        );
        for (const message of received.Messages ?? []) {
          if (!message.Body) continue;
          try {
            await handler(JSON.parse(message.Body) as WorkflowMessage);
            // Delete only on success: an un-deleted message becomes visible
            // again after the visibility timeout — at-least-once by design.
            await this.client.send(
              new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle })
            );
          } catch {
            // Leave it for redelivery.
          }
        }
      }
    };

    void loop();

    return async () => {
      running = false;
    };
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.client.destroy();
  }
}

registerQueueDriver("sqs", (options) => new SqsQueueDriver(options));
```

- [ ] **Step 5: Run tests**

Run: `npm test -w @wfe/core -- sqs`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core package-lock.json
git commit -m "feat(core): add SQS queue driver"
```

---

### Task 8: Worker runtime

**Files:**
- Create: `packages/core/src/worker/worker.ts`
- Test: `packages/core/test/worker/worker.test.ts`

**Interfaces:**
- Consumes: `QueueDriver`, `RunExecutor.resume`/`callback`, `DELAY_QUEUE`, `RESPONSE_QUEUE`.
- Produces: `class WorkflowWorker { constructor(deps: { executor: RunExecutor; queue: QueueDriver; services?: string[]; logger?: Logger }); start(): Promise<void>; stop(): Promise<void> }`. Plan 3's CLI (`wfe worker`) runs this.

**What it does:** subscribes to the delay queue, the response queue, and one queue per configured external service; routes each message to `resume` or `callback`; and shuts down cleanly. A handler that throws must let the message be redelivered, **except** for errors that will never succeed on retry — a `RUN_CONFLICT` (another consumer won) and a `RUN_NOT_FOUND` are both terminal for that message, so the worker swallows them rather than spinning forever.

- [ ] **Step 1: Write the failing test**

`packages/core/test/worker/worker.test.ts`:

```typescript
import { WorkflowStatus } from "@wfe/sdk";
import { MemoryQueueDriver } from "../../src/queue/memory-driver";
import { DELAY_QUEUE, RESPONSE_QUEUE } from "../../src/queue/names";
import { WorkflowMessage } from "../../src/queue/types";
import { WfeError } from "../../src/errors";
import { WorkflowWorker } from "../../src/worker/worker";

describe("WorkflowWorker", () => {
  let queue: MemoryQueueDriver;

  beforeEach(async () => {
    queue = new MemoryQueueDriver();
    await queue.ensureQueues([{ queueName: DELAY_QUEUE }, { queueName: RESPONSE_QUEUE }]);
  });

  afterEach(() => queue.close());

  function fakeExecutor(overrides: Partial<Record<"resume" | "callback", jest.Mock>> = {}) {
    return {
      resume: overrides.resume ?? jest.fn().mockResolvedValue({ status: WorkflowStatus.COMPLETE }),
      callback: overrides.callback ?? jest.fn().mockResolvedValue({ status: WorkflowStatus.COMPLETE }),
    };
  }

  const resumeMsg: WorkflowMessage = {
    tenantId: "default", runId: 1, stepNumber: 0, kind: "resume",
  };
  const callbackMsg: WorkflowMessage = {
    tenantId: "default", runId: 2, stepNumber: 1, kind: "callback", body: { ok: true },
  };

  it("routes a resume message to executor.resume", async () => {
    const executor = fakeExecutor();
    const worker = new WorkflowWorker({ executor: executor as never, queue });
    await worker.start();

    await queue.publish(DELAY_QUEUE, resumeMsg);
    await queue.drain();

    expect(executor.resume).toHaveBeenCalledWith(resumeMsg);
    await worker.stop();
  });

  it("routes a callback message to executor.callback with its payload", async () => {
    const executor = fakeExecutor();
    const worker = new WorkflowWorker({ executor: executor as never, queue });
    await worker.start();

    await queue.publish(RESPONSE_QUEUE, callbackMsg);
    await queue.drain();

    expect(executor.callback).toHaveBeenCalledWith("default", 2, 1, { ok: true });
    await worker.stop();
  });

  it("leaves a message for redelivery when the handler fails transiently", async () => {
    const resume = jest.fn().mockRejectedValue(new Error("database down"));
    const worker = new WorkflowWorker({ executor: fakeExecutor({ resume }) as never, queue });
    await worker.start();

    await queue.publish(DELAY_QUEUE, resumeMsg);
    await queue.drain();
    expect(queue.pending(DELAY_QUEUE)).toHaveLength(1);

    await worker.stop();
  });

  it("consumes a message whose run conflicts — another consumer won", async () => {
    const resume = jest.fn().mockRejectedValue(
      new WfeError("conflict", { statusCode: 409, code: "RUN_CONFLICT" })
    );
    const worker = new WorkflowWorker({ executor: fakeExecutor({ resume }) as never, queue });
    await worker.start();

    await queue.publish(DELAY_QUEUE, resumeMsg);
    await queue.drain();
    expect(queue.pending(DELAY_QUEUE)).toHaveLength(0);

    await worker.stop();
  });

  it("consumes a message whose run no longer exists", async () => {
    const resume = jest.fn().mockRejectedValue(
      new WfeError("gone", { statusCode: 404, code: "RUN_NOT_FOUND" })
    );
    const worker = new WorkflowWorker({ executor: fakeExecutor({ resume }) as never, queue });
    await worker.start();

    await queue.publish(DELAY_QUEUE, resumeMsg);
    await queue.drain();
    expect(queue.pending(DELAY_QUEUE)).toHaveLength(0);

    await worker.stop();
  });

  it("stops delivering after stop()", async () => {
    const executor = fakeExecutor();
    const worker = new WorkflowWorker({ executor: executor as never, queue });
    await worker.start();
    await worker.stop();

    await queue.publish(DELAY_QUEUE, resumeMsg);
    await queue.drain();
    expect(executor.resume).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @wfe/core -- worker`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the worker**

`packages/core/src/worker/worker.ts`:

```typescript
import { Logger } from "@wfe/sdk";
import { RunExecutor } from "../engine/run-executor";
import { WfeError } from "../errors";
import { createLogger } from "../logging";
import { DELAY_QUEUE, RESPONSE_QUEUE, serviceQueueName } from "../queue/names";
import { QueueDriver, Unsubscribe, WorkflowMessage } from "../queue/types";

export interface WorkflowWorkerDeps {
  executor: RunExecutor;
  queue: QueueDriver;
  /** External service names whose request queues this worker should also drain. */
  services?: string[];
  logger?: Logger;
}

/**
 * Errors that will never succeed on redelivery: another consumer already won
 * the run, or the run is gone. Retrying these forever would be a hot loop.
 */
const TERMINAL_CODES = new Set(["RUN_CONFLICT", "RUN_NOT_FOUND", "CALLBACK_STEP_MISMATCH"]);

export class WorkflowWorker {
  private readonly executor: RunExecutor;
  private readonly queue: QueueDriver;
  private readonly services: string[];
  private readonly log: Logger;
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(deps: WorkflowWorkerDeps) {
    this.executor = deps.executor;
    this.queue = deps.queue;
    this.services = deps.services ?? [];
    this.log = deps.logger ?? createLogger("workflow-worker");
  }

  async start(): Promise<void> {
    const queues = [DELAY_QUEUE, RESPONSE_QUEUE, ...this.services.map(serviceQueueName)];
    await this.queue.ensureQueues(queues.map((queueName) => ({ queueName })));

    for (const queueName of queues) {
      const stop = await this.queue.subscribe(queueName, (msg) => this.handle(msg));
      this.subscriptions.push(stop);
    }
    this.log.info("Worker started", { queues });
  }

  private async handle(msg: WorkflowMessage): Promise<void> {
    try {
      if (msg.kind === "callback") {
        await this.executor.callback(msg.tenantId, msg.runId, msg.stepNumber, msg.body);
      } else {
        await this.executor.resume(msg);
      }
    } catch (err) {
      const code = err instanceof WfeError ? err.code : undefined;
      if (code && TERMINAL_CODES.has(code)) {
        // Consume it: redelivery cannot help, and requeueing would spin.
        this.log.warn("Discarding message that cannot succeed on retry", {
          runId: msg.runId, stepNumber: msg.stepNumber, code,
        });
        return;
      }
      this.log.error("Message handling failed; leaving it for redelivery", {
        runId: msg.runId, stepNumber: msg.stepNumber, error: (err as Error).message,
      });
      throw err;
    }
  }

  async stop(): Promise<void> {
    for (const stop of this.subscriptions) {
      await stop();
    }
    this.subscriptions.length = 0;
    this.log.info("Worker stopped");
  }
}
```

- [ ] **Step 4: Run tests, then the full suite**

Run: `npm test -w @wfe/core -- worker`
Expected: PASS — 6 tests.

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add worker runtime for delay, response and service queues"
```

---

### Task 9: Compose, exports, example and docs

**Files:**
- Create: `docker-compose.yml`, `examples/definitions/delayed.json`, `examples/run-delayed.ts`
- Modify: `packages/core/src/index.ts` (export the queue, worker and suspension surface), `README.md`
- Test: `packages/core/test/engine/delayed-example.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: barrel exports for `queue/types`, `queue/registry`, `queue/memory-driver`, `queue/names`, `engine/suspension`, `worker/worker`, `steps/external-task-step`; a compose file bringing up Postgres and RabbitMQ; a delayed example.

Note the barrel must **not** export `rabbitmq-driver` or `sqs-driver` — importing those modules pulls in `amqplib` and the AWS SDK, and registers the driver as a side effect. Consumers import them explicitly when they want them, which is what keeps a memory-driver deployment free of broker clients.

- [ ] **Step 1: Write the failing end-to-end test**

`packages/core/test/engine/delayed-example.test.ts`:

```typescript
import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DbContext, DefinitionRepository, ExpressionEvaluator, MemoryQueueDriver,
  RunExecutor, StepRegistry, WorkflowWorker, DELAY_QUEUE,
  registerBuiltInSteps, validateDefinitionShape,
} from "../../src";

jest.setTimeout(120000);

describe("delayed example definition", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let queue: MemoryQueueDriver;
  let executor: RunExecutor;
  let evaluator: ExpressionEvaluator;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    queue = new MemoryQueueDriver();
    await queue.ensureQueues([{ queueName: DELAY_QUEUE }]);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    executor = new RunExecutor({ config, db, registry, evaluator, queue });

    const raw = JSON.parse(
      readFileSync(join(__dirname, "../../../../examples/definitions/delayed.json"), "utf8")
    );
    const body = await validateDefinitionShape(raw.definition);
    await new DefinitionRepository(db).create({
      tenantId: "default", name: raw.workflowName, version: raw.workflowVersion,
      definition: body, status: WorkflowDefinitionStatus.PUBLISHED,
    });
  });

  afterAll(async () => {
    evaluator.dispose();
    await queue.close();
    await db.close();
    await container.stop();
  });

  it("suspends, is resumed by the worker, and completes", async () => {
    const worker = new WorkflowWorker({ executor, queue });
    await worker.start();

    const runId = await executor.startWorkflow({
      tenantId: "default", name: "delayed", version: "1.0.0", inputs: { jobId: "job-7" },
    });
    const parked = await executor.start("default", runId);
    expect(parked.status).toBe(WorkflowStatus.WAITING);

    // The resume message is queued but not yet visible: draining now must not
    // advance the run, which is what proves the delay is actually honoured.
    await queue.drain();
    const stillParked = await new (await import("../../src/repositories/run-repository")).RunRepository(db)
      .findById("default", runId);
    expect(stillParked!.status).toBe(WorkflowStatus.WAITING);

    queue.advanceTime(60_000);
    await queue.drain();

    const finished = await new (await import("../../src/repositories/run-repository")).RunRepository(db)
      .findById("default", runId);
    expect(finished!.status).toBe(WorkflowStatus.COMPLETE);
    expect(finished!.outputs).toMatchObject({ jobId: "job-7" });

    await worker.stop();
  });
});
```

- [ ] **Step 2: Write the delayed example definition**

`examples/definitions/delayed.json`:

```json
{
  "workflowName": "delayed",
  "workflowVersion": "1.0.0",
  "status": "published",
  "definition": {
    "steps": [
      {
        "stepName": "Prepare",
        "stepVersion": "1.0.0",
        "stepType": "core.transform",
        "stepInputs": [
          { "targetFieldName": "jobId", "modelEvaluationExpression": "workflowState.inputs.jobId" }
        ]
      },
      {
        "stepName": "Wait",
        "stepVersion": "1.0.0",
        "stepType": "core.delay",
        "stepInputs": [
          { "targetFieldName": "seconds", "modelEvaluationExpression": "Number(45)" }
        ]
      },
      {
        "stepName": "Finish",
        "stepVersion": "1.0.0",
        "stepType": "core.noop",
        "stepInputs": [],
        "stepOutputs": [
          { "targetFieldName": "jobId", "modelEvaluationExpression": "workflowState.stepStates.Prepare.outputs.jobId" }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Add the `core.delay` step**

`packages/core/src/steps/delay-step.ts`:

```typescript
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

/** Suspends the run for the number of seconds named by its `seconds` input. */
export class DelayStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (ctx.isResume) {
      ctx.step.status = WorkflowStatus.COMPLETE;
      return { stepState: ctx.step };
    }
    const seconds = Number(ctx.inputs.seconds ?? 0);
    ctx.step.status = WorkflowStatus.WAITING;
    return { stepState: ctx.step, suspend: { kind: "delay", delaySeconds: seconds } };
  }
}
```

Register it in `registerBuiltInSteps` as `core.delay`, and update the registry test's `list()` assertion to expect all four built-ins.

- [ ] **Step 4: Update the barrel**

Add to `packages/core/src/index.ts`:

```typescript
export * from "./queue/types";
export * from "./queue/registry";
export * from "./queue/memory-driver";
export * from "./queue/names";
export * from "./engine/suspension";
export * from "./worker/worker";
export * from "./steps/delay-step";
export * from "./steps/external-task-step";
```

Do not add the rabbitmq or sqs drivers — importing them registers a driver and pulls in a broker client as a side effect.

- [ ] **Step 5: Write the compose file**

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: wfe
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 10

  rabbitmq:
    image: rabbitmq:3.13-management-alpine
    ports:
      - "5672:5672"
      - "15672:15672"
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 10s
      timeout: 5s
      retries: 10
```

- [ ] **Step 6: Run tests**

Run: `npm test -w @wfe/core -- delayed-example`
Expected: PASS.

Run: `npm test` — full suite.

- [ ] **Step 7: Update the README**

Add a **Queues** section documenting: the driver registry and how to select one, `WFE_QUEUE_DRIVER` / `WFE_QUEUE_URL` / `WFE_SQS_PREFIX` / `AWS_REGION`, the three suspension modes with a code sample per mode, how delay chaining makes a 30-day delay work on a 900-second driver, running the worker, and `docker compose up` for local Postgres + RabbitMQ. Update the roadmap table to mark Phase 2 complete. Update the "Writing a step" section to show `start` and `isResume`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add delay step, compose file, queue exports and Phase 2 docs"
```

---

## Out of scope for this plan

Deferred deliberately, each with a reason:

- **Snapshotting the definition onto the run.** Still open from Phase 1's final review; in-flight runs re-read the live definition row. It becomes urgent when Plan 3 ships `PUT /definitions/:id`, so it belongs there.
- **`RunRepository` list/search, `DefinitionRepository` list/update/publish.** Plan 3 needs them for the REST surface and should define them against its own query shapes.
- **Dead-letter queues and poison-message handling.** The worker distinguishes terminal from transient failures, but a message that fails transiently forever is still redelivered forever. Needs a retry counter and a DLQ per driver — a coherent chunk of its own.
- **Kafka, Redis or Postgres queue drivers.** The registry makes each additive; none is required by the spec.
- **Spec §7.2's remaining `StepContext` fields — `db`, `queue` and `emitProgress`.** `emitProgress`'s absence is why the `progress_*` columns are still dead schema. Adding it needs a progress-persistence path and a decision about write frequency under load; `db`/`queue` on the context invite steps to bypass the executor entirely, which wants thinking about rather than shipping by default.
- **Worker scaling and prefetch tuning.** One consumer per queue is correct for now; the version column makes multiple consumers safe, but sizing them is an operational question with no test to write yet.
