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
