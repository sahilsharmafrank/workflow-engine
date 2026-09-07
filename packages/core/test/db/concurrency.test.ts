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

  it("rejects with RUN_NOT_FOUND, not RUN_CONFLICT, when the entity's tenant doesn't match the row", async () => {
    // The lock read is tenant-scoped like every other repository query. A
    // real caller can only ever hold an entity it read through a
    // tenant-scoped path (findById takes a tenantId), so this can't happen
    // from findById alone — it guards a caller that obtained the entity some
    // other way with the wrong tenant stamped on it.
    const saved = await newRun();
    saved.status = WorkflowStatus.COMPLETE;
    saved.tenantId = "someone-elses-tenant";

    await expect(runs.saveChecked(saved)).rejects.toMatchObject({
      code: "RUN_NOT_FOUND", statusCode: 404,
    });

    const reloaded = await runs.findById("default", saved.id!);
    expect(reloaded!.status).toBe(WorkflowStatus.RUNNING);
    expect(reloaded!.revision).toBe(1);
  });

  it("closes the race under genuine concurrency, not just sequential test ordering", async () => {
    // Every test above awaits the first saveChecked before starting the
    // second, so all of them would still pass against a broken implementation
    // that drops the transaction/FOR UPDATE entirely (a bare read followed by
    // a plain save()) — that shape only fails when two callers are actually
    // blocked on the row at the same instant. Firing both with no `await`
    // between them is necessary but NOT sufficient to force that: on a local,
    // fast connection the two calls can still fully serialize by accident
    // (one's SELECT-then-UPDATE completing before the other's SELECT even
    // runs), which made an earlier version of this test pass against the
    // broken shape too — confirmed by deliberately reintroducing the broken
    // shape and watching it pass 5/5 runs. So this holds the row lock itself
    // first, fires both `saveChecked` calls into that lock (both must then be
    // genuinely blocked waiting on it, not just "started"), and only then
    // releases it — that is what makes the overlap real instead of assumed.
    const saved = await newRun();
    const a = await runs.findById("default", saved.id!);
    const b = await runs.findById("default", saved.id!);
    a!.status = WorkflowStatus.COMPLETE;
    b!.status = WorkflowStatus.FAILED;

    const ds = await db.getDataSource();
    const holder = ds.createQueryRunner();
    await holder.startTransaction();
    await holder.query(`SELECT revision FROM workflow_run WHERE id = $1 FOR UPDATE`, [saved.id]);

    const settled = Promise.allSettled([runs.saveChecked(a!), runs.saveChecked(b!)]);
    // Let both calls reach and block on the row lock we're holding before we
    // let either through — otherwise this degenerates back into the same
    // "maybe they overlap, maybe they don't" shape as firing them bare.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await holder.commitTransaction(); // releases the lock; we changed nothing
    await holder.release();

    const results = await settled;
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<WorkflowRun> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "RUN_CONFLICT", statusCode: 409 });

    const reloaded = await runs.findById("default", saved.id!);
    expect(reloaded!.revision).toBe(2);
  });
});

describe("saveChecked lock timeout", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let runs: RunRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    // A short bound so the test doesn't wait out a multi-second default; the
    // behaviour under test is "fails promptly", not the specific duration.
    db = new DbContext({ dbUrl: container.getConnectionUri(), lockTimeoutMs: 200 });
    await db.runMigrations();
    runs = new RunRepository(db);
  });

  afterAll(async () => {
    await db.close();
    await container.stop();
  });

  it("fails fast with RUN_LOCK_TIMEOUT instead of hanging when the row is held elsewhere", async () => {
    const run = new WorkflowRun();
    run.tenantId = "default";
    run.name = "conc";
    run.version = "1.0.0";
    run.currentStep = 0;
    run.status = WorkflowStatus.RUNNING;
    run.inputs = {};
    run.outputs = {};
    run.state = {};
    const saved = await runs.save(run);

    // Hold the row lock in a separate, never-committed transaction — standing
    // in for another connection that is (for whatever reason) slow to finish
    // its own saveChecked.
    const ds = await db.getDataSource();
    const holder = ds.createQueryRunner();
    await holder.startTransaction();
    try {
      await holder.query(`SELECT revision FROM workflow_run WHERE id = $1 FOR UPDATE`, [saved.id]);

      const loaded = await runs.findById("default", saved.id!);
      loaded!.status = WorkflowStatus.COMPLETE;

      const start = Date.now();
      await expect(runs.saveChecked(loaded!)).rejects.toMatchObject({
        code: "RUN_LOCK_TIMEOUT", statusCode: 503,
      });
      // Bounded well under jest's 120s suite timeout — proves this failed
      // because of lock_timeout, not because something else eventually erred.
      expect(Date.now() - start).toBeLessThan(5000);
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
    }
  });
});
