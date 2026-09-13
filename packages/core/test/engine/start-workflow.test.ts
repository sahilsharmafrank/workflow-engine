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

  it("rejects a run that omits a required declared input, without creating a run row", async () => {
    await new DefinitionRepository(db).create({
      tenantId: "default", name: "needs-job-id", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: {
        steps: [{ stepName: "Only", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
        inputSchema: [{ name: "jobId", type: "string", required: true }],
      },
    });

    const before = await runs.list("default", { name: "needs-job-id" });
    await expect(
      manager.startWorkflow({ tenantId: "default", name: "needs-job-id", version: "1.0.0", inputs: {} })
    ).rejects.toMatchObject({ code: "RUN_INPUT_MISSING" });
    const after = await runs.list("default", { name: "needs-job-id" });
    expect(after.total).toBe(before.total);
  });

  it("starts a run when the required declared input is present", async () => {
    const runId = await manager.startWorkflow({
      tenantId: "default", name: "needs-job-id", version: "1.0.0", inputs: { jobId: "j-1" },
    });
    const run = await runs.findById("default", runId);
    expect(run!.inputs).toEqual({ jobId: "j-1" });
  });
});
