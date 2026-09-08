import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../../src/db/db-context";
import { RunExecutor } from "../../src/engine/run-executor";
import { ExpressionEvaluator } from "../../src/expression/evaluator";
import { MemoryQueueDriver } from "../../src/queue/memory-driver";
import { DELAY_QUEUE, serviceQueueName } from "../../src/queue/names";
import { StepRegistry, registerBuiltInSteps } from "../../src/registry/step-registry";
import { DefinitionRepository } from "../../src/repositories/definition-repository";
import { RunRepository } from "../../src/repositories/run-repository";

jest.setTimeout(120000);

describe("callback resumption", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let queue: MemoryQueueDriver;
  let executor: RunExecutor;
  let runs: RunRepository;
  let evaluator: ExpressionEvaluator;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);

    queue = new MemoryQueueDriver();
    await queue.ensureQueues([
      { queueName: DELAY_QUEUE }, { queueName: serviceQueueName("billing") },
    ]);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    executor = new RunExecutor({ config, db, registry, evaluator, queue });
    runs = new RunRepository(db);
  });

  afterAll(async () => {
    evaluator.dispose();
    await queue.close();
    await db.close();
    await container.stop();
  });

  async function startExternalRun(name: string): Promise<number> {
    await new DefinitionRepository(db).create({
      tenantId: "default", name, version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: {
        steps: [
          {
            stepName: "Charge", stepVersion: "1.0.0", stepType: "core.externalTask",
            externalServiceName: "billing",
            stepInputs: [
              { targetFieldName: "amount", modelEvaluationExpression: "Number(500)" },
            ],
          },
          {
            stepName: "Record", stepVersion: "1.0.0", stepType: "core.transform",
            stepInputs: [
              {
                targetFieldName: "receipt",
                modelEvaluationExpression: "workflowState.stepStates.Charge.outputs.receiptId",
              },
            ],
          },
        ],
      } as never,
    });
    return executor.startWorkflow({ tenantId: "default", name, version: "1.0.0", inputs: {} });
  }

  it("dispatches a request to the service queue and parks the run", async () => {
    const runId = await startExternalRun("cb-1");
    const run = await executor.start("default", runId);

    expect(run.status).toBe(WorkflowStatus.WAITING);
    const dispatched = queue.pending(serviceQueueName("billing"));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ runId, stepNumber: 0 });
    expect(run.stepRuns![0].status).toBe(WorkflowStatus.WAITING);
  });

  it("resumes the parked step with the callback payload and finishes the run", async () => {
    const runId = await startExternalRun("cb-2");
    await executor.start("default", runId);

    const finished = await executor.callback("default", runId, 0, { receiptId: "rcpt-9" });

    expect(finished.status).toBe(WorkflowStatus.COMPLETE);
    expect(finished.stepRuns![0].outputs).toMatchObject({ receiptId: "rcpt-9" });
    expect(finished.stepRuns![1].inputs).toMatchObject({ receipt: "rcpt-9" });
  });

  it("rejects a callback for a step the run is not parked on", async () => {
    const runId = await startExternalRun("cb-3");
    await executor.start("default", runId);

    await expect(executor.callback("default", runId, 1, {})).rejects.toMatchObject({
      code: "CALLBACK_STEP_MISMATCH",
    });
  });

  it("rejects a callback for a cancelled run", async () => {
    const runId = await startExternalRun("cb-4");
    await executor.start("default", runId);
    await executor.cancel("default", runId);

    const run = await executor.callback("default", runId, 0, { receiptId: "x" });
    expect(run.status).toBe(WorkflowStatus.CANCELLED);
  });

  it("does not re-dispatch the request when resumed", async () => {
    const runId = await startExternalRun("cb-5");
    await executor.start("default", runId);
    const before = queue.pending(serviceQueueName("billing")).length;

    await executor.callback("default", runId, 0, { receiptId: "rcpt-1" });

    expect(queue.pending(serviceQueueName("billing"))).toHaveLength(before);
  });
});
