import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowStatus } from "@wfe/sdk";
import { DataSource } from "typeorm";
import { DbContext } from "../../src/db/db-context";
import { Progress } from "../../src/entities/progress";
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

  it("defaults tenantId to 'default' at the database level", async () => {
    // Bypasses the entity/repository entirely — a raw INSERT with tenant_id
    // omitted is the honest way to exercise the column's DEFAULT 'default',
    // rather than asserting a value the test itself just set.
    const ds = await db.getDataSource();
    const rows = await ds.query(
      `INSERT INTO workflow_run (name, version, current_step, status)
       VALUES ($1, $2, $3, $4) RETURNING tenant_id`,
      ["no-tenant-set", "1.0.0", -1, WorkflowStatus.STARTING]
    );
    expect(rows[0].tenant_id).toBe("default");
  });

  it("writes run_id on cascaded step rows", async () => {
    const saved = await saveRun();
    const ds = await db.getDataSource();
    const rows = await ds.query("SELECT run_id FROM step_run WHERE run_id = $1", [saved.id]);
    expect(rows).toHaveLength(2);
  });

  it("memoizes concurrent getDataSource calls to a single DataSource", async () => {
    const cold = new DbContext({ dbUrl: container.getConnectionUri(), showSql: false });
    try {
      const [a, b] = await Promise.all([cold.getDataSource(), cold.getDataSource()]);
      expect(a).toBe(b);
    } finally {
      await cold.close();
    }
  });

  it("retries after a failed initialize instead of caching the rejection forever", async () => {
    // Against the old code, `dataSourcePromise ??= ...` memoizes the *rejected*
    // promise once initialize() fails, so every later getDataSource() call on
    // this instance returns that same rejection until close() is called — even
    // though the connection would succeed on a retry.
    const retryable = new DbContext({ dbUrl: container.getConnectionUri(), showSql: false });
    let calls = 0;
    const original = DataSource.prototype.initialize;
    const spy = jest
      .spyOn(DataSource.prototype, "initialize")
      .mockImplementation(function (this: DataSource) {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error("simulated initialize failure"));
        }
        return original.apply(this);
      });
    try {
      await expect(retryable.getDataSource()).rejects.toThrow("simulated initialize failure");
      const ds = await retryable.getDataSource();
      expect(ds.isInitialized).toBe(true);
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
      await retryable.close();
    }
  });

  it("round-trips progress through the bigint columns as numbers", async () => {
    const saved = await saveRun();
    const ds = await db.getDataSource();
    const step = saved.stepRuns![0];
    step.progress = new Progress();
    step.progress.units = "items";
    step.progress.totalExpected = 100;
    step.progress.currentProgress = 42;
    await ds.getRepository(StepRun).save(step);

    const loaded = await ds.getRepository(StepRun).findOneByOrFail({ id: step.id });
    expect(typeof loaded.progress!.totalExpected).toBe("number");
    expect(typeof loaded.progress!.currentProgress).toBe("number");
    expect(loaded.progress!.totalExpected).toBe(100);
    expect(loaded.progress!.currentProgress).toBe(42);
  });
});
