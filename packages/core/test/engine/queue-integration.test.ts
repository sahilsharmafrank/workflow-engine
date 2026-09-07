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
