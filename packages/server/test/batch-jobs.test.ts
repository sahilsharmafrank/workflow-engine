import "reflect-metadata";
import request from "supertest";
import { Express } from "express";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  DbContext, ExpressionEvaluator, RunExecutor, StepRegistry, registerBuiltInSteps,
  DefinitionRepository, validateDefinitionShape, MemoryQueueDriver, DELAY_QUEUE, RESPONSE_QUEUE,
} from "@wfe/core";
import { WorkflowDefinitionStatus } from "@wfe/sdk";
import { createApp } from "../src/app";
import { NoneAuthProvider } from "../src/auth/none-provider";

jest.setTimeout(120000);

describe("Batch jobs", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let app: Express;
  let evaluator: ExpressionEvaluator;
  let queue: MemoryQueueDriver;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    queue = new MemoryQueueDriver();
    await queue.ensureQueues([{ queueName: DELAY_QUEUE }, { queueName: RESPONSE_QUEUE }]);
    const executor = new RunExecutor({
      config, db, registry, evaluator, queue,
    });
    app = createApp({
      executor, db, registry, authProvider: new NoneAuthProvider(), evaluator, queue,
    });

    // Publish a definition for batch fan-out
    const defs = new DefinitionRepository(db);
    const body = await validateDefinitionShape({
      steps: [{ stepName: "T", stepVersion: "1.0.0", stepType: "core.transform",
        stepInputs: [{ targetFieldName: "x", modelEvaluationExpression: "workflowState.inputs.x" }] }],
    });
    await defs.create({
      tenantId: "default", name: "batch-target", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED, definition: body,
    });

    // A second definition whose step parks in WAITING until an explicit
    // callback arrives, so runs started from it stay genuinely in-flight
    // (not already complete) for the cancel tests below.
    const waitingBody = await validateDefinitionShape({
      steps: [{
        stepName: "Ext", stepVersion: "1.0.0", stepType: "core.externalTask",
        externalServiceName: "svc", stepInputs: [],
      }],
    });
    await defs.create({
      tenantId: "default", name: "cancel-target", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED, definition: waitingBody,
    });
  });

  afterAll(async () => {
    evaluator.dispose();
    await queue.close();
    await db.close();
    await container.stop();
  });

  it("POST /api/v1/batch-jobs creates a batch and fans out runs", async () => {
    const res = await request(app)
      .post("/api/v1/batch-jobs")
      .send({
        name: "test-batch",
        definitionName: "batch-target",
        definitionVersion: "1.0.0",
        inputs: [{ x: 1 }, { x: 2 }, { x: 3 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.totalCount).toBe(3);
    expect(res.body.runIds).toHaveLength(3);
    expect(res.body.status).toBe("running");
  });

  it("GET /api/v1/batch-jobs lists batch jobs", async () => {
    const res = await request(app).get("/api/v1/batch-jobs");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/v1/batch-jobs/:id returns batch with progress", async () => {
    const create = await request(app)
      .post("/api/v1/batch-jobs")
      .send({
        name: "progress-batch",
        definitionName: "batch-target",
        definitionVersion: "1.0.0",
        inputs: [{ x: 10 }],
      });
    const res = await request(app).get(`/api/v1/batch-jobs/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("progress");
    // The single run uses a core.transform step, which never suspends, so by
    // the time POST /batch-jobs has returned the run must already be
    // complete. Assert the actual counts, not just key presence — a
    // hardcoded zeroed object, or the uppercase-status regression fixed in
    // 45d3d74, would both pass a mere toHaveProperty check.
    expect(res.body.progress).toEqual({
      completedCount: 1,
      failedCount: 0,
      runningCount: 0,
    });
  });

  it("PUT /api/v1/batch-jobs/:id/cancel cancels the batch", async () => {
    const create = await request(app)
      .post("/api/v1/batch-jobs")
      .send({
        name: "cancel-batch",
        definitionName: "cancel-target",
        definitionVersion: "1.0.0",
        inputs: [{ x: 20 }],
      });
    expect(create.body.status).toBe("running");
    const [runId] = create.body.runIds;

    // Sanity check: the run must still be in flight (parked on the external
    // task) before we cancel it — otherwise "cancel" would have nothing to do
    // and the assertions below would be vacuous.
    const before = await request(app).get(`/api/v1/runs/${runId}`);
    expect(before.body.status).toBe("waiting");

    const res = await request(app).put(`/api/v1/batch-jobs/${create.body.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");

    // The response body alone doesn't prove the cancel loop actually reached
    // the underlying run — read it back independently and confirm it really
    // transitioned, rather than trusting the batch job's own echoed status.
    const after = await request(app).get(`/api/v1/runs/${runId}`);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe("cancelled");
  });

  it("PUT /api/v1/batch-jobs/:id/cancel rejects a batch already in a terminal state", async () => {
    // An unpublished version makes startWorkflow throw for every input,
    // driving the batch job straight to "failed" with a message describing
    // the cause — a terminal state reachable without any extra plumbing.
    const create = await request(app)
      .post("/api/v1/batch-jobs")
      .send({
        name: "terminal-batch",
        definitionName: "batch-target",
        definitionVersion: "99.99.99",
        inputs: [{ x: 30 }],
      });
    expect(create.body.status).toBe("failed");
    expect(create.body.message).toBeTruthy();

    const res = await request(app).put(`/api/v1/batch-jobs/${create.body.id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BATCH_JOB_NOT_CANCELLABLE");

    // The record must be left untouched — a caller who tried to cancel a
    // failed batch should still see the original failure, not a status that
    // now contradicts its own message.
    const after = await request(app).get(`/api/v1/batch-jobs/${create.body.id}`);
    expect(after.body.status).toBe("failed");
    expect(after.body.message).toBe(create.body.message);
  });
});
