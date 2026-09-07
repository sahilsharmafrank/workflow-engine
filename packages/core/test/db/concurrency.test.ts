import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { WorkflowRun } from "../../src/entities/workflow-run";
import { WfeError } from "../../src/errors";
import { RunRepository } from "../../src/repositories/run-repository";

jest.setTimeout(120000);

describe("optimistic concurrency", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let runs: RunRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    db = new DbContext({ dbUrl: container.getConnectionUri() });
    await db.runMigrations();
    runs = new RunRepository(db);
  });

  afterAll(async () => {
    await db.close();
    await container.stop();
  });

  async function newRun(): Promise<WorkflowRun> {
    const run = new WorkflowRun();
    run.tenantId = "default";
    run.name = "conc";
    run.version = "1.0.0";
    run.currentStep = 0;
    run.status = WorkflowStatus.RUNNING;
    run.inputs = {};
    run.outputs = {};
    run.state = {};
    return runs.save(run);
  }

  it("starts a new run at revision 1", async () => {
    const saved = await newRun();
    expect(saved.revision).toBe(1);
  });

  it("increments the revision on each save", async () => {
    const saved = await newRun();
    saved.status = WorkflowStatus.WAITING;
    const again = await runs.saveChecked(saved);
    expect(again.revision).toBe(2);
  });

  it("rejects a stale write with RUN_CONFLICT", async () => {
    const saved = await newRun();

    // Two consumers load the same row — the shape at-least-once delivery produces.
    const a = await runs.findById("default", saved.id!);
    const b = await runs.findById("default", saved.id!);

    a!.status = WorkflowStatus.COMPLETE;
    await runs.saveChecked(a!);

    b!.status = WorkflowStatus.FAILED;
    await expect(runs.saveChecked(b!)).rejects.toMatchObject({
      code: "RUN_CONFLICT", statusCode: 409,
    });
  });

  it("leaves the winner's value in place after a conflict", async () => {
    const saved = await newRun();
    const a = await runs.findById("default", saved.id!);
    const b = await runs.findById("default", saved.id!);

    a!.status = WorkflowStatus.COMPLETE;
    await runs.saveChecked(a!);
    b!.status = WorkflowStatus.FAILED;
    await runs.saveChecked(b!).catch((err) => expect(err).toBeInstanceOf(WfeError));

    const reloaded = await runs.findById("default", saved.id!);
    expect(reloaded!.status).toBe(WorkflowStatus.COMPLETE);
  });
});
