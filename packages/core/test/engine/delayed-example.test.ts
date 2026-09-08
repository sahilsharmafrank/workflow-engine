import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DbContext, DefinitionRepository, ExpressionEvaluator, MemoryQueueDriver,
  RunExecutor, StepRegistry, WorkflowWorker, DELAY_QUEUE,
  registerBuiltInSteps, validateDefinitionShape,
} from "../../src";

jest.setTimeout(120000);

describe("delayed example definition", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let queue: MemoryQueueDriver;
  let executor: RunExecutor;
  let evaluator: ExpressionEvaluator;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    queue = new MemoryQueueDriver();
    await queue.ensureQueues([{ queueName: DELAY_QUEUE }]);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    executor = new RunExecutor({ config, db, registry, evaluator, queue });

    const raw = JSON.parse(
      readFileSync(join(__dirname, "../../../../examples/definitions/delayed.json"), "utf8")
    );
    const body = await validateDefinitionShape(raw.definition);
    await new DefinitionRepository(db).create({
      tenantId: "default", name: raw.workflowName, version: raw.workflowVersion,
      definition: body, status: WorkflowDefinitionStatus.PUBLISHED,
    });
  });

  afterAll(async () => {
    evaluator.dispose();
    await queue.close();
    await db.close();
    await container.stop();
  });

  it("suspends, is resumed by the worker, and completes", async () => {
    const worker = new WorkflowWorker({ executor, queue });
    await worker.start();

    const runId = await executor.startWorkflow({
      tenantId: "default", name: "delayed", version: "1.0.0", inputs: { jobId: "job-7" },
    });
    const parked = await executor.start("default", runId);
    expect(parked.status).toBe(WorkflowStatus.WAITING);

    // The resume message is queued but not yet visible: draining now must not
    // advance the run, which is what proves the delay is actually honoured.
    await queue.drain();
    const stillParked = await new (await import("../../src/repositories/run-repository")).RunRepository(db)
      .findById("default", runId);
    expect(stillParked!.status).toBe(WorkflowStatus.WAITING);

    queue.advanceTime(60_000);
    await queue.drain();

    const finished = await new (await import("../../src/repositories/run-repository")).RunRepository(db)
      .findById("default", runId);
    expect(finished!.status).toBe(WorkflowStatus.COMPLETE);
    expect(finished!.outputs).toMatchObject({ jobId: "job-7" });

    await worker.stop();
  });
});
