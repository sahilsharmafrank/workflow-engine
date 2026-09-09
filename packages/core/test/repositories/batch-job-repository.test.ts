import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DbContext } from "../../src/db/db-context";
import { BatchJobRepository } from "../../src/repositories/batch-job-repository";

jest.setTimeout(120000);

describe("BatchJobRepository", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let repo: BatchJobRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    db = new DbContext({ dbUrl: container.getConnectionUri() });
    await db.runMigrations();
    repo = new BatchJobRepository(db);
  });

  afterAll(async () => {
    await db.close();
    await container.stop();
  });

  it("creates and retrieves a batch job", async () => {
    const job = await repo.create({
      tenantId: "default",
      name: "test-batch",
      definitionName: "my-workflow",
      definitionVersion: "1.0.0",
      status: "pending",
      totalCount: 3,
      inputs: [{ a: 1 }, { a: 2 }, { a: 3 }],
      runIds: [],
    });
    expect(job.id).toBeDefined();

    const found = await repo.findById("default", job.id!);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("test-batch");
    expect(found!.inputs).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(found!.totalCount).toBe(3);
  });

  it("lists batch jobs with status filter", async () => {
    await repo.create({
      tenantId: "default", name: "b1", definitionName: "wf", definitionVersion: "1",
      status: "running", totalCount: 1, inputs: [{}], runIds: [],
    });
    await repo.create({
      tenantId: "default", name: "b2", definitionName: "wf", definitionVersion: "1",
      status: "complete", totalCount: 1, inputs: [{}], runIds: [],
    });

    const running = await repo.list("default", { status: "running" });
    expect(running.every((j) => j.status === "running")).toBe(true);
  });

  it("updates a batch job", async () => {
    const job = await repo.create({
      tenantId: "default", name: "b-update", definitionName: "wf", definitionVersion: "1",
      status: "pending", totalCount: 1, inputs: [{}], runIds: [],
    });
    const updated = await repo.update("default", job.id!, {
      status: "running",
      runIds: [10, 20],
    });
    expect(updated.status).toBe("running");
    expect(updated.runIds).toEqual([10, 20]);
  });
});
