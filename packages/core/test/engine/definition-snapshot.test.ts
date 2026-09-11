import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { WorkflowDefinitionEntity } from "../../src/entities/workflow-definition";
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
    // Create and publish a 2-step workflow
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

    // Mutate the persisted definition directly (bypass the repository guard) to simulate
    // "definition changed after run started, but run should still use its snapshot".
    // This bypasses DefinitionRepository.update()'s guard by writing directly to the DB.
    const ds = await db.getDataSource();
    const entity = await ds.getRepository(WorkflowDefinitionEntity).findOneBy({ id: def.id });
    if (entity) {
      entity.definition = { steps: [
        { stepName: "First", stepVersion: "1.0.0", stepType: "core.transform",
          stepInputs: [{ targetFieldName: "x", modelEvaluationExpression: "Number(999)" }] },
        { stepName: "Injected", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
        { stepName: "Second", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
      ] };
      await ds.getRepository(WorkflowDefinitionEntity).save(entity);
    }

    // Restart from step 0 — should use the ORIGINAL 2-step snapshot, not the 3-step live definition
    const restarted = await executor.restartFromStep("default", runId, 0);
    // The run should complete with 2 steps (from snapshot), not 3 (from the live mutated definition)
    expect(restarted.stepRuns).toHaveLength(2);
    expect(restarted.status).toBe(WorkflowStatus.COMPLETE);
  });
});
