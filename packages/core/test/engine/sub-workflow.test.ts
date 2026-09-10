import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkflowDefinitionStatus, WorkflowStatus } from "@wfe/sdk";
import {
  DbContext, DefinitionRepository, ExpressionEvaluator, MemoryQueueDriver,
  RunExecutor, RunRepository, StepRegistry, WorkflowWorker, DELAY_QUEUE,
  registerBuiltInSteps,
} from "../../src";

jest.setTimeout(120000);

/**
 * Proves core.subWorkflow actually executes its child.
 *
 * The pre-existing unit test (test/steps/sub-workflow-step.test.ts) mocks
 * ctx.startChildWorkflow, so it only ever checks that the mock was called
 * with the right arguments — it can't see whether a real child run ever
 * advances. That's exactly why the bug shipped: RunExecutor wired
 * startChildWorkflow to WorkflowManager.startWorkflow, which only creates
 * the run row (status STARTING, currentStep -1) and returns its id. Nothing
 * ever called start() on it, and nothing polls for STARTING runs, so the
 * child sat there forever while the parent happily reported COMPLETE.
 *
 * This test drives a real parent definition through a real RunExecutor, a
 * real MemoryQueueDriver, and a real WorkflowWorker draining the queue, and
 * asserts the child run actually reaches a terminal state.
 */
describe("core.subWorkflow end to end", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let queue: MemoryQueueDriver;
  let executor: RunExecutor;
  let runs: RunRepository;
  let evaluator: ExpressionEvaluator;
  let registry: StepRegistry;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    registry = new StepRegistry();
    registerBuiltInSteps(registry);

    queue = new MemoryQueueDriver();
    await queue.ensureQueues([{ queueName: DELAY_QUEUE }]);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    executor = new RunExecutor({ config, db, registry, evaluator, queue });
    runs = new RunRepository(db);

    await new DefinitionRepository(db).create({
      tenantId: "default", name: "child-def", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: {
        steps: [
          {
            stepName: "Done", stepVersion: "1.0.0", stepType: "core.transform",
            stepInputs: [
              { targetFieldName: "greeting", modelEvaluationExpression: `"hello from child"` },
            ],
          },
        ],
      } as never,
    });

    await new DefinitionRepository(db).create({
      tenantId: "default", name: "parent-def", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: {
        steps: [
          {
            stepName: "Spawn", stepVersion: "1.0.0", stepType: "core.subWorkflow",
            stepInputs: [
              { targetFieldName: "name", modelEvaluationExpression: `"child-def"` },
              { targetFieldName: "version", modelEvaluationExpression: `"1.0.0"` },
              { targetFieldName: "inputs", modelEvaluationExpression: `({})` },
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

  it("actually starts and completes the child run, not just a row", async () => {
    const worker = new WorkflowWorker({ executor, queue });
    await worker.start();

    const parentRunId = await executor.startWorkflow({
      tenantId: "default", name: "parent-def", version: "1.0.0", inputs: {},
    });
    const parent = await executor.start("default", parentRunId);
    expect(parent.status).toBe(WorkflowStatus.COMPLETE);

    const childRunId = parent.stepRuns?.[0].outputs?.childRunId as number | undefined;
    expect(typeof childRunId).toBe("number");

    // The row existing is not evidence the bug is fixed — the bug also
    // creates this row. Confirm it starts life un-started (STARTING), so
    // the COMPLETE assertion below is proof of real execution picking it
    // up out of band, not a race that happened to finish inline already.
    const beforeDrain = await runs.findById("default", childRunId!);
    expect(beforeDrain!.status).toBe(WorkflowStatus.STARTING);

    // Nothing has run the child yet except the worker draining its queue.
    await queue.drain();

    const child = await runs.findById("default", childRunId!);
    expect(child!.status).toBe(WorkflowStatus.COMPLETE);
    expect(child!.stepRuns?.[0].outputs).toMatchObject({ greeting: "hello from child" });

    await worker.stop();
  });

  /**
   * Part (a) is what makes recursion reachable at all — before this fix, a
   * self-starting definition's child would just sit in STARTING forever,
   * same as any other child. Once the out-of-band publish actually executes
   * children, a self-referencing (or mutually-recursive) definition would
   * otherwise fill the database and the queue: auth is deliberately `none`
   * in v1, so any definition author can trigger it. This proves the depth
   * guard stops that instead of it running away.
   */
  it("stops a self-referencing definition at the configured depth limit", async () => {
    const depthQueue = new MemoryQueueDriver();
    await depthQueue.ensureQueues([{ queueName: DELAY_QUEUE }]);
    const depthExecutor = new RunExecutor({
      config: { dbUrl: container.getConnectionUri(), maxSubWorkflowDepth: 1 },
      db, registry, evaluator, queue: depthQueue,
    });

    await new DefinitionRepository(db).create({
      tenantId: "default", name: "self-ref", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: {
        steps: [
          {
            stepName: "Recurse", stepVersion: "1.0.0", stepType: "core.subWorkflow",
            stepInputs: [
              { targetFieldName: "name", modelEvaluationExpression: `"self-ref"` },
              { targetFieldName: "version", modelEvaluationExpression: `"1.0.0"` },
              { targetFieldName: "inputs", modelEvaluationExpression: `({})` },
            ],
          },
        ],
      } as never,
    });

    const rootRunId = await depthExecutor.startWorkflow({
      tenantId: "default", name: "self-ref", version: "1.0.0", inputs: {},
    });
    // Root is a normal start: depth 0. Its step spawns a depth-1 child,
    // which is still within the limit of 1, so the root itself completes.
    const root = await depthExecutor.start("default", rootRunId);
    expect(root.status).toBe(WorkflowStatus.COMPLETE);

    const pendingAfterRoot = depthQueue.pending(DELAY_QUEUE);
    expect(pendingAfterRoot).toHaveLength(1);
    const childMsg = pendingAfterRoot[0];

    // Drive the depth-1 child's resume directly, rather than through
    // WorkflowWorker (which treats any non-terminal-coded error as
    // redeliverable and swallows it) — this is what lets the assertion
    // below see the guard's error surface, not just get silently retried.
    await expect(depthExecutor.resume(childMsg)).rejects.toMatchObject({
      code: "SUB_WORKFLOW_DEPTH_EXCEEDED",
    });

    const child = await runs.findById("default", childMsg.runId);
    expect(child!.status).toBe(WorkflowStatus.FAILED);
    expect(child!.stepRuns?.[0].message).toMatch(/exceeds the configured maximum of 1/);

    // The guard fired before any grandchild row or further publish was
    // created — the queue still holds only the one (now-consumed) message
    // for the depth-1 child, never a second one for a depth-2 grandchild.
    // That's the proof the recursion is bounded, not merely failing once
    // after already running away.
    expect(depthQueue.pending(DELAY_QUEUE)).toEqual([childMsg]);
    const { total } = await runs.list("default", { name: "self-ref" });
    expect(total).toBe(2); // the root and the one depth-1 child, nothing beyond it

    await depthQueue.close();
  });
});
