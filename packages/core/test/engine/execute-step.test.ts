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

class NoStatusStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    // Deliberately never touches ctx.step.status, mimicking a third-party
    // step author who forgot to.
    return { stepState: ctx.step };
  }
}

let skipCallCount = 0;
class SkipCountingStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    skipCallCount += 1;
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

describe("RunExecutor.executeStep", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let executor: RunExecutor;
  let registry: StepRegistry;
  let runs: RunRepository;
  let definitions: DefinitionRepository;
  let evaluator: ExpressionEvaluator;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    registry = new StepRegistry();
    registerBuiltInSteps(registry);
    registry.register({ type: "test.delaying", version: "1.0.0", factory: (p) => new DelayingStep(p) });
    registry.register({ type: "test.exploding", version: "1.0.0", factory: (p) => new ExplodingStep(p) });
    registry.register({ type: "test.no-status", version: "1.0.0", factory: (p) => new NoStatusStep(p) });
    registry.register({ type: "test.skip-counting", version: "1.0.0", factory: (p) => new SkipCountingStep(p) });

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

  it("skips the step when a pre-flight check fails with SKIP, without running it", async () => {
    // A step type that unconditionally sets COMPLETE (like core.transform)
    // makes this assertion pass whether or not the SKIP branch actually
    // returns early — it would pass even against a "SKIP that still runs the
    // step" bug, since the step's own status write happens to match. Using a
    // step that counts its own invocations, and asserting that count is
    // zero, actually proves step.run() was never called.
    skipCallCount = 0;
    const runId = await startRun("pf-skip", [
      { stepName: "T", stepVersion: "1.0.0", stepType: "test.skip-counting", stepInputs: [],
        preFlightCheck: {
          conditionsToCheck: [{ targetFieldName: "ok", modelEvaluationExpression: "workflowState.inputs.go === true" }],
          actionOnFailure: PreFlightCheckActionOutcome.SKIP,
        } },
    ], { go: false });

    const run = await runs.findById("default", runId);
    const result = await executor.executeStep(run!, 0);
    expect(result.run.stepRuns![0].status).toBe(WorkflowStatus.SKIPPED);
    expect(skipCallCount).toBe(0);
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

  it("exposes only allowlisted expressionValues to expressions, and dbUrl is never reachable", async () => {
    // dbUrl is a sibling field of EngineConfig, not part of expressionValues,
    // so naming it in expressionConfigKeys must not resurrect access to the
    // real (credentialed) database connection string.
    const configuredExecutor = new RunExecutor({
      config: {
        dbUrl: container.getConnectionUri(),
        expressionValues: { greeting: "hello", secretApiKey: "sekret" },
        expressionConfigKeys: ["greeting", "dbUrl"],
      },
      db, registry, evaluator,
    });

    const runId = await startRun("cfg-1", [
      { stepName: "T", stepVersion: "1.0.0", stepType: "core.transform",
        stepInputs: [
          { targetFieldName: "greeting", modelEvaluationExpression: "config.greeting" },
          { targetFieldName: "secretApiKey", modelEvaluationExpression: "config.secretApiKey" },
          { targetFieldName: "dbUrl", modelEvaluationExpression: "config.dbUrl" },
        ] },
    ]);

    const run = await runs.findById("default", runId);
    const result = await configuredExecutor.executeStep(run!, 0);
    expect(result.run.stepRuns![0].inputs.greeting).toBe("hello");
    expect(result.run.stepRuns![0].inputs.secretApiKey).toBeUndefined();
    expect(result.run.stepRuns![0].inputs.dbUrl).toBeUndefined();
  });

  it("settles a step to COMPLETE when the step itself never sets a terminal status", async () => {
    // Plan 4 loads arbitrary third-party step plugins, so a step author who
    // returns without touching ctx.step.status must not leave that row
    // RUNNING forever while the run moves on and reports success.
    const runId = await startRun("no-status", [
      { stepName: "N", stepVersion: "1.0.0", stepType: "test.no-status", stepInputs: [] },
    ]);
    const run = await runs.findById("default", runId);
    const result = await executor.executeStep(run!, 0);
    expect(result.run.stepRuns![0].status).toBe(WorkflowStatus.COMPLETE);
  });

  it("throws a WfeError instead of a raw TypeError when the step-run row is missing", async () => {
    const runId = await startRun("missing-row", [
      { stepName: "T", stepVersion: "1.0.0", stepType: "core.transform", stepInputs: [] },
    ]);
    const run = await runs.findById("default", runId);
    // Simulate a run whose step-run rows no longer cover this index (e.g. the
    // definition gained a step while this run was in flight).
    run!.stepRuns = [];
    await expect(executor.executeStep(run!, 0)).rejects.toMatchObject({
      statusCode: 400, code: "STEP_RUN_MISSING",
    });
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
