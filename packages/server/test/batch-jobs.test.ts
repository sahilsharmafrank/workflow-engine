import "reflect-metadata";
import request from "supertest";
import { Express } from "express";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  DbContext, ExpressionEvaluator, RunExecutor, StepRegistry, registerBuiltInSteps,
  DefinitionRepository, validateDefinitionShape,
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

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    const executor = new RunExecutor({ config, db, registry, evaluator });
    app = createApp({ executor, db, registry, authProvider: new NoneAuthProvider(), evaluator });

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
  });

  afterAll(async () => {
    evaluator.dispose();
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
    expect(res.body.progress).toHaveProperty("completedCount");
  });

  it("PUT /api/v1/batch-jobs/:id/cancel cancels the batch", async () => {
    const create = await request(app)
      .post("/api/v1/batch-jobs")
      .send({
        name: "cancel-batch",
        definitionName: "batch-target",
        definitionVersion: "1.0.0",
        inputs: [{ x: 20 }],
      });
    const res = await request(app).put(`/api/v1/batch-jobs/${create.body.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });
});
