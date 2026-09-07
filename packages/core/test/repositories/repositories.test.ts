import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { StepRun } from "../../src/entities/step-run";
import { WorkflowRun } from "../../src/entities/workflow-run";
import { DefinitionRepository } from "../../src/repositories/definition-repository";
import { RunRepository } from "../../src/repositories/run-repository";

jest.setTimeout(120000);

describe("repositories", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let definitions: DefinitionRepository;
  let runs: RunRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    db = new DbContext({ dbUrl: container.getConnectionUri() });
    await db.runMigrations();
    definitions = new DefinitionRepository(db);
    runs = new RunRepository(db);
  });

  afterAll(async () => {
    await db.close();
    await container.stop();
  });

  const body = { steps: [] };

  it("creates and reads back a definition", async () => {
    const created = await definitions.create({
      tenantId: "default", name: "wf-a", version: "1.0.0", definition: body,
    });
    const found = await definitions.findById("default", created.id!);
    expect(found?.name).toBe("wf-a");
    expect(found?.status).toBe(WorkflowDefinitionStatus.DRAFT);
  });

  it("does not return a definition belonging to another tenant", async () => {
    const created = await definitions.create({
      tenantId: "tenant-a", name: "wf-b", version: "1.0.0", definition: body,
    });
    await expect(definitions.findById("tenant-b", created.id!)).resolves.toBeNull();
  });

  it("finds the published definition by name and version", async () => {
    await definitions.create({
      tenantId: "default", name: "wf-c", version: "1.0.0",
      definition: body, status: WorkflowDefinitionStatus.PUBLISHED,
    });
    const found = await definitions.findPublished("default", "wf-c", "1.0.0");
    expect(found?.name).toBe("wf-c");
  });

  it("ignores a draft when looking for a published definition", async () => {
    await definitions.create({
      tenantId: "default", name: "wf-d", version: "1.0.0", definition: body,
    });
    await expect(definitions.findPublished("default", "wf-d", "1.0.0")).resolves.toBeNull();
  });

  it("saves a run and reads it back with its steps", async () => {
    const run = new WorkflowRun();
    run.tenantId = "default";
    run.name = "wf-a";
    run.version = "1.0.0";
    run.currentStep = -1;
    run.status = WorkflowStatus.STARTING;
    run.inputs = { a: 1 };
    // Create steps in deliberately non-sequential stepNumber order (2, 0, 1)
    // to verify that @AfterLoad sort runs and eager loading works
    run.stepRuns = [
      Object.assign(new StepRun(), {
        stepNumber: 2,
        stepName: "step-c",
        stepType: "action",
        status: WorkflowStatus.COMPLETE,
        inputs: { x: 3 },
        outputs: { y: 4 },
        state: {},
      }),
      Object.assign(new StepRun(), {
        stepNumber: 0,
        stepName: "step-a",
        stepType: "action",
        status: WorkflowStatus.COMPLETE,
        inputs: { x: 1 },
        outputs: { y: 2 },
        state: {},
      }),
      Object.assign(new StepRun(), {
        stepNumber: 1,
        stepName: "step-b",
        stepType: "action",
        status: WorkflowStatus.COMPLETE,
        inputs: { x: 2 },
        outputs: { y: 3 },
        state: {},
      }),
    ];
    const saved = await runs.save(run);
    const found = await runs.findById("default", saved.id!);
    expect(found?.inputs).toEqual({ a: 1 });
    expect(found?.stepRuns).toHaveLength(3);
    expect(found?.stepRuns?.map(s => s.stepNumber)).toEqual([0, 1, 2]);
  });

  it("does not return a run belonging to another tenant", async () => {
    const run = new WorkflowRun();
    run.tenantId = "tenant-a";
    run.name = "wf-a";
    run.version = "1.0.0";
    run.currentStep = -1;
    run.status = WorkflowStatus.STARTING;
    const saved = await runs.save(run);
    await expect(runs.findById("tenant-b", saved.id!)).resolves.toBeNull();
  });
});
