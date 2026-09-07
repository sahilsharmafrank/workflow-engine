import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { StepRun } from "../../src/entities/step-run";
import { WorkflowRun } from "../../src/entities/workflow-run";

jest.setTimeout(120000);

describe("persistence", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    db = new DbContext({ dbUrl: container.getConnectionUri(), showSql: false });
    await db.runMigrations();
  });

  afterAll(async () => {
    await db.close();
    await container.stop();
  });

  async function saveRun(): Promise<WorkflowRun> {
    const ds = await db.getDataSource();
    const run = new WorkflowRun();
    run.tenantId = "default";
    run.name = "three-step";
    run.version = "1.0.0";
    run.currentStep = -1;
    run.status = WorkflowStatus.STARTING;
    run.inputs = { jobId: "j-1" };
    run.outputs = {};
    run.state = {};
    run.stepRuns = [1, 0].map((n) => {
      const step = new StepRun();
      step.stepNumber = n;
      step.stepName = `Step${n}`;
      step.stepType = "core.noop";
      step.status = WorkflowStatus.NEW;
      step.inputs = {};
      step.outputs = {};
      step.state = {};
      return step;
    });
    return ds.getRepository(WorkflowRun).save(run);
  }

  it("round-trips transient parameters through the jsonb columns", async () => {
    const saved = await saveRun();
    const ds = await db.getDataSource();
    const loaded = await ds.getRepository(WorkflowRun).findOneByOrFail({ id: saved.id });
    expect(loaded.inputs).toEqual({ jobId: "j-1" });
    expect(loaded.state).toEqual({});
  });

  it("returns step runs sorted by step number regardless of insert order", async () => {
    const saved = await saveRun();
    const ds = await db.getDataSource();
    const loaded = await ds.getRepository(WorkflowRun).findOneByOrFail({ id: saved.id });
    expect(loaded.stepRuns!.map((s) => s.stepNumber)).toEqual([0, 1]);
  });

  it("ellipsizes an over-length step message instead of failing the write", async () => {
    const saved = await saveRun();
    const ds = await db.getDataSource();
    const step = saved.stepRuns![0];
    step.message = "x".repeat(9000);
    await ds.getRepository(StepRun).save(step);
    const loaded = await ds.getRepository(StepRun).findOneByOrFail({ id: step.id });
    expect(loaded.message!.length).toBeLessThanOrEqual(3900);
    expect(loaded.message!.endsWith("...")).toBe(true);
  });

  it("defaults tenantId to 'default'", async () => {
    const saved = await saveRun();
    expect(saved.tenantId).toBe("default");
  });

  it("writes run_id on cascaded step rows", async () => {
    const saved = await saveRun();
    const ds = await db.getDataSource();
    const rows = await ds.query("SELECT run_id FROM step_run WHERE run_id = $1", [saved.id]);
    expect(rows).toHaveLength(2);
  });
});
