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

// Hoisted to module scope (rather than declared inside the describe block
// below) so the step classes below — which must themselves be declared
// before any describe/beforeAll assigns these — can close over the same
// executor/db instances the tests use. Mirrors run-loop.test.ts's pattern.
let executor: RunExecutor;
let db: DbContext;

// Set by LockHoldingStep once it has taken the row lock; the test that uses
// it releases the lock through this after asserting on the resulting error.
let lockHolderRelease: (() => Promise<void>) | undefined;

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

// Requests a delay well past the memory driver's 900s maxDelaySeconds, so
// resuming it exercises the chaining path in resume()/publishSuspension.
class LongSleepStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (ctx.isResume) {
      ctx.step.status = WorkflowStatus.COMPLETE;
      return { stepState: ctx.step };
    }
    ctx.step.status = WorkflowStatus.WAITING;
    return { stepState: ctx.step, suspend: { kind: "delay", delaySeconds: 2000 } };
  }
}

// Suspends on an awaitCallback with no queue named — there is nothing for
// core to schedule a resume on, so publishSuspension/planSuspension must
// refuse this rather than silently parking on DELAY_QUEUE.
class UnnamedCallbackStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.status = WorkflowStatus.WAITING;
    return { stepState: ctx.step, suspend: { kind: "awaitCallback" } };
  }
}

// Cancels its own run mid-execution (the same shape as run-loop.test.ts's
// CancellingStep) and then throws, standing in for a step whose own failure
// races a concurrent operator cancel(). The cancelled status must survive.
class CancelThenThrowStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    await executor.cancel(ctx.run.tenantId, ctx.run.id!);
    throw new Error("boom after cancel");
  }
}

// Takes the row's FOR UPDATE lock on a separate, never-committed transaction
// and holds it past the executor's configured lock_timeout, so the
// executor's own completion save times out with RUN_LOCK_TIMEOUT instead of
// succeeding. Standing in for another writer that is slow to finish its own
// checked save on the same run.
class LockHoldingStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    const ds = await db.getDataSource();
    const holder = ds.createQueryRunner();
    await holder.startTransaction();
    await holder.query("SELECT revision FROM workflow_run WHERE id = $1 FOR UPDATE", [ctx.run.id]);
    lockHolderRelease = async () => {
      await holder.rollbackTransaction();
      await holder.release();
    };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
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

  it("refuses an await-callback suspension that names no queue", () => {
    expect(() => planSuspension({ kind: "awaitCallback" }, 900)).toThrow(/queue/i);
  });
});

describe("executor queue integration", () => {
  let container: StartedPostgreSqlContainer;
  let queue: MemoryQueueDriver;
  let runs: RunRepository;
  let evaluator: ExpressionEvaluator;
  let registry: StepRegistry;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    registry = new StepRegistry();
    registerBuiltInSteps(registry);
    registry.register({ type: "test.counting", version: "1.0.0", factory: (p) => new CountingStep(p) });
    registry.register({ type: "test.sleep", version: "1.0.0", factory: (p) => new SleepStep(p) });
    registry.register({ type: "test.long-sleep", version: "1.0.0", factory: (p) => new LongSleepStep(p) });
    registry.register({ type: "test.unnamed-callback", version: "1.0.0", factory: (p) => new UnnamedCallbackStep(p) });
    registry.register({ type: "test.cancel-then-throw", version: "1.0.0", factory: (p) => new CancelThenThrowStep(p) });
    registry.register({ type: "test.lock-holding", version: "1.0.0", factory: (p) => new LockHoldingStep(p) });

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

  it("fails loudly when an awaitCallback suspension names no queue to park on", async () => {
    const runId = await startRun("q-6", ["test.unnamed-callback"]);
    await expect(executor.start("default", runId)).rejects.toThrow(/queue/i);
  });

  it("chains a delay longer than the driver maximum across two hops", async () => {
    const runId = await startRun("q-7", ["test.long-sleep", "test.counting"]);
    const run = await executor.start("default", runId);
    expect(run.status).toBe(WorkflowStatus.WAITING);

    const forRun = () => queue.pending(DELAY_QUEUE).filter((m) => m.runId === runId);

    // 2000s requested, capped at the driver's 900s maximum: 900 spent now,
    // 1100 still owed and carried in the message.
    let batch = forRun();
    expect(batch).toHaveLength(1);
    const first = batch[0];
    expect(first).toMatchObject({ tenantId: "default", runId, stepNumber: 0, kind: "resume" });
    expect(first.remainingDelaySeconds).toBe(1100);

    const afterFirstResume = await executor.resume(first);
    // A message still carrying a remainder must be re-published, not
    // executed: the run stays WAITING and the next step must not have run.
    expect(afterFirstResume.status).toBe(WorkflowStatus.WAITING);
    expect(runCount).toBe(0);

    // The original message is never removed by resume() itself — that is
    // the queue driver's job once it has a consumer (out of scope here) —
    // so a second, newly published message should now sit alongside it.
    batch = forRun();
    expect(batch).toHaveLength(2);
    const second = batch[1];
    expect(second).toMatchObject({ tenantId: "default", runId, stepNumber: 0, kind: "resume" });
    // Another 900s spent from the 1100 owed: 200 left, strictly less than
    // what was carried into this hop.
    expect(second.remainingDelaySeconds).toBe(200);
    expect(second.remainingDelaySeconds).toBeLessThan(first.remainingDelaySeconds!);

    // Resuming the second message chains once more (200s still owed) rather
    // than executing; only the resulting third, remainder-free message
    // actually resumes the step.
    const afterSecondResume = await executor.resume(second);
    expect(afterSecondResume.status).toBe(WorkflowStatus.WAITING);
    expect(runCount).toBe(0);
    const third = forRun()[2];
    expect(third.remainingDelaySeconds).toBe(0);
    const finished = await executor.resume(third);
    expect(finished.status).toBe(WorkflowStatus.COMPLETE);
    expect(runCount).toBe(1);
  });

  it("discards a stale chained-delay hop once the run has moved past that step", async () => {
    // Step 0's delay is long enough to chain (2000s > the 900s driver cap);
    // step 1's is short enough to resolve in a single hop. Both suspend the
    // run without landing it in a resume-blocked status, so the only thing
    // that can catch a stale hop for step 0 after the run has moved to step
    // 1 is the currentStep guard itself.
    const runId = await startRun("q-10", ["test.long-sleep", "test.sleep", "test.counting"]);
    const started = await executor.start("default", runId);
    expect(started.status).toBe(WorkflowStatus.WAITING);
    expect(started.currentStep).toBe(0);

    const forRun = () => queue.pending(DELAY_QUEUE).filter((m) => m.runId === runId);
    const stale = forRun().find((m) => m.stepNumber === 0)!;
    expect(stale.remainingDelaySeconds).toBe(1100);

    // Move the run onto a later step while step 0's chained delay is still
    // in flight — the same shape restartFromStep produces mid-chain. The run
    // lands WAITING (on step 1's own delay), not in any resume-blocked
    // status, so the existing isResumeBlocked() check alone cannot discard
    // the stale step-0 hop below.
    const restarted = await executor.restartFromStep("default", runId, 1);
    expect(restarted.status).toBe(WorkflowStatus.WAITING);
    expect(restarted.currentStep).toBe(1);

    await executor.resume(stale);

    // No new hop may ever be published for the abandoned step 0: only the
    // original (never-dequeued) message should remain.
    const staleHopsAfter = forRun().filter((m) => m.stepNumber === 0);
    expect(staleHopsAfter).toHaveLength(1);
    expect(staleHopsAfter[0].remainingDelaySeconds).toBe(1100);
  });

  it("keeps a concurrently cancelled run CANCELLED when the step that raced it then throws", async () => {
    const runId = await startRun("q-8", ["test.cancel-then-throw"]);
    await expect(executor.start("default", runId)).rejects.toThrow(/boom after cancel/);
    const reloaded = await runs.findById("default", runId);
    expect(reloaded!.status).toBe(WorkflowStatus.CANCELLED);
  });

  it("does not persist FAILED when the completion save times out on a contended lock", async () => {
    const shortLockDb = new DbContext({ dbUrl: container.getConnectionUri(), lockTimeoutMs: 200 });
    const shortLockExecutor = new RunExecutor({
      config: { dbUrl: container.getConnectionUri() },
      db: shortLockDb,
      registry: (executor as unknown as { registry: StepRegistry }).registry,
      evaluator,
      queue,
    });

    const runId = await startRun("q-9", ["test.lock-holding"]);
    try {
      await expect(shortLockExecutor.start("default", runId)).rejects.toMatchObject({
        code: "RUN_LOCK_TIMEOUT",
      });
    } finally {
      await lockHolderRelease?.();
      lockHolderRelease = undefined;
      await shortLockDb.close();
    }

    const reloaded = await runs.findById("default", runId);
    expect(reloaded!.status).not.toBe(WorkflowStatus.FAILED);
  });
});
