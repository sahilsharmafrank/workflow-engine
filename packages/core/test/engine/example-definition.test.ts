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
