import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import {
  DbContext, DefinitionRepository, ExpressionEvaluator, MemoryQueueDriver,
  RunExecutor, RunRepository, StepRegistry, WorkflowWorker, DELAY_QUEUE, RESPONSE_QUEUE,
  registerBuiltInSteps,
} from "../../src";

jest.setTimeout(120000);

/**
 * Reproduces the exact topology C1 of the final whole-branch review flagged:
 * a real RunExecutor, a real WorkflowWorker, and a core.externalTask step
 * targeting an external service, driven over a real (in-memory) queue
 * driver rather than a mocked executor or a hand-constructed message.
 *
 * The load-bearing assertion is the mid-drain one: the run must still be
 * WAITING after the worker drains the queue following the dispatch, and
 * only advance once a genuine reply arrives. A test that only checked the
 * final COMPLETE state would also pass against the bug this guards
 * (the worker consuming its own dispatch and completing the step with
 * empty outputs) — see the RED run recorded in the fix report for proof.
 */
describe("external task + worker end to end", () => {
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
    await queue.ensureQueues([{ queueName: DELAY_QUEUE }, { queueName: RESPONSE_QUEUE }]);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    executor = new RunExecutor({ config, db, registry, evaluator, queue });
    runs = new RunRepository(db);

    await new DefinitionRepository(db).create({
      tenantId: "default", name: "billing-charge", version: "1.0.0",
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
  });

  afterAll(async () => {
    evaluator.dispose();
    await queue.close();
    await db.close();
    await container.stop();
  });

  it("parks on the external dispatch, survives a drain, and only completes on a real reply", async () => {
    const worker = new WorkflowWorker({ executor, queue });
    await worker.start();

    const runId = await executor.startWorkflow({
      tenantId: "default", name: "billing-charge", version: "1.0.0", inputs: {},
    });
    const parked = await executor.start("default", runId);
    expect(parked.status).toBe(WorkflowStatus.WAITING);

    // The dispatch to wfe-service-billing is sitting in the queue right now.
    // Draining must NOT let the worker consume it as if it were the reply:
    // the run has to still be WAITING afterwards. This is the assertion
    // that catches the engine eating its own outbound dispatch.
    await queue.drain();
    const stillParked = await runs.findById("default", runId);
    expect(stillParked!.status).toBe(WorkflowStatus.WAITING);
    expect(stillParked!.stepRuns![0].outputs).toEqual({});

    // Deliver the reply the correct way: a real callback message on
    // RESPONSE_QUEUE, not a message on the service's dispatch queue.
    await queue.publish(RESPONSE_QUEUE, {
      tenantId: "default", runId, stepNumber: 0, kind: "callback",
      body: { receiptId: "rcpt-42" },
    });
    await queue.drain();

    const finished = await runs.findById("default", runId);
    expect(finished!.status).toBe(WorkflowStatus.COMPLETE);
    expect(finished!.stepRuns![0].outputs).toEqual({ receiptId: "rcpt-42" });
    expect(finished!.stepRuns![1].inputs).toMatchObject({ receipt: "rcpt-42" });

    await worker.stop();
  });
});
