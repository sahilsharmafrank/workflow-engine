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
let executor: RunExecutor;

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

// Cancels its own run mid-execution, out of band — the way an operator's
// concurrent cancel() call would race with an in-flight step, but
// deterministic: the cancel is guaranteed to land before this step (and
// therefore executeStep's own completion save) returns.
class CancellingStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    runCount += 1;
    await executor.cancel(ctx.run.tenantId, ctx.run.id!);
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

describe("RunExecutor.run", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
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
    registry.register({ type: "test.cancelling", version: "1.0.0", factory: (p) => new CancellingStep(p) });

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

  it("discards a resume message for a completed (resume-blocked) run", async () => {
    // Guard 2 (isResumeBlocked) fires here, before guard 3 is ever reached:
    // the run is COMPLETE by the time we call run() again.
    const runId = await startRun("loop-3", threeSteps("test.counting"));
    await executor.start("default", runId);
    runCount = 0;
    await executor.run("default", runId, 0);
    expect(runCount).toBe(0);
  });

  it("discards a resume message whose step number is stale, while the run is still live", async () => {
    // Guard 3 (run.currentStep !== stepNumber) is the one under test here.
    // WAITING is not resume-blocked (isResumeBlocked covers only COMPLETE,
    // FAILED, CANCELLED, CANCELLING, PAUSED), so guard 2 does not fire and
    // this message reaches guard 3: currentStep is 1, but the message is for
    // step 0 — a step the run has already moved past.
    const runId = await startRun("loop-3b", [
      { stepName: "One", stepVersion: "1.0.0", stepType: "test.counting", stepInputs: [] },
      { stepName: "Two", stepVersion: "1.0.0", stepType: "test.waiting", stepInputs: [] },
      { stepName: "Three", stepVersion: "1.0.0", stepType: "test.counting", stepInputs: [] },
    ]);
    const started = await executor.start("default", runId);
    expect(started.status).toBe(WorkflowStatus.WAITING);
    expect(started.currentStep).toBe(1);

    runCount = 0;
    const result = await executor.run("default", runId, 0);
    expect(runCount).toBe(0);
    expect(result.currentStep).toBe(1);
    expect(result.status).toBe(WorkflowStatus.WAITING);
  });

  it("discards a stepNumber other than 0 against a run that has never started", async () => {
    // The -1 exception in guard 3 must only admit stepNumber 0. A fresh run
    // sits at currentStep -1; a message for any other step number (here 2)
    // is stale or malformed and must not silently skip steps 0 and 1.
    const runId = await startRun("loop-3c", threeSteps("test.counting"));
    runCount = 0;
    const result = await executor.run("default", runId, 2);
    expect(runCount).toBe(0);
    expect(result.currentStep).toBe(-1);
    expect(result.status).toBe(WorkflowStatus.STARTING);
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

  it("stops advancing once a step cancels its own run out of band, and leaves it CANCELLED", async () => {
    // Against the old code, executeStep's own completion save (and the top
    // of the next loop iteration) both blindly write the stale in-memory
    // run's status — RUNNING — clobbering the CANCELLED that cancel() just
    // wrote to the database. Step 1 (and 2) would then run anyway.
    const runId = await startRun("loop-7", threeSteps("test.cancelling"));
    runCount = 0;
    const run = await executor.start("default", runId);
    expect(runCount).toBe(1); // only step 0 ran; steps 1 and 2 must not have
    expect(run.status).toBe(WorkflowStatus.CANCELLED);
    const reloaded = await runs.findById("default", runId);
    expect(reloaded!.status).toBe(WorkflowStatus.CANCELLED);
  });

  it("marks a cancelled run CANCELLED and stops advancing it", async () => {
    const runId = await startRun("loop-6", threeSteps("test.waiting"));
    await executor.start("default", runId);
    const cancelled = await executor.cancel("default", runId);
    expect(cancelled.status).toBe(WorkflowStatus.CANCELLED);
    const reloaded = await runs.findById("default", runId);
    expect(reloaded!.status).toBe(WorkflowStatus.CANCELLED);
  });

  it("rejects restartFromStep with an out-of-range step instead of completing having run nothing", async () => {
    // Against the old code: currentStep is set to 99, the "reached the end"
    // guard passes (99 === 99), the while(99 < 3) loop body never runs, and
    // the run is marked COMPLETE having executed zero steps.
    const runId = await startRun("loop-8", threeSteps("test.counting"));
    await executor.start("default", runId);
    runCount = 0;
    await expect(executor.restartFromStep("default", runId, 99)).rejects.toMatchObject({
      statusCode: 400, code: "RESTART_STEP_OUT_OF_RANGE",
    });
    expect(runCount).toBe(0);
  });

  it("rejects restartFromStep with a negative step instead of stranding the run in RUNNING", async () => {
    const runId = await startRun("loop-9", threeSteps("test.counting"));
    await executor.start("default", runId);
    await expect(executor.restartFromStep("default", runId, -1)).rejects.toMatchObject({
      statusCode: 400, code: "RESTART_STEP_OUT_OF_RANGE",
    });
  });

  it("refuses to restart a cancelled run", async () => {
    // Against the old code, restartFromStep unconditionally sets
    // status = RUNNING, silently overwriting CANCELLED and defeating cancel.
    const runId = await startRun("loop-10", threeSteps("test.waiting"));
    await executor.start("default", runId);
    await executor.cancel("default", runId);
    runCount = 0;
    await expect(executor.restartFromStep("default", runId, 0)).rejects.toMatchObject({
      statusCode: 400, code: "RUN_CANCELLED",
    });
    expect(runCount).toBe(0);
    const reloaded = await runs.findById("default", runId);
    expect(reloaded!.status).toBe(WorkflowStatus.CANCELLED);
  });
});
