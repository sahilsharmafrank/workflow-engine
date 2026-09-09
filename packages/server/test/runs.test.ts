import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DefinitionRepository } from "@wfe/core";
import { WorkflowDefinitionStatus } from "@wfe/sdk";
import request from "supertest";
import { createTestApp, TestContext } from "./helpers";

jest.setTimeout(120000);

const simpleDef = {
  steps: [
    { stepName: "S1", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
    { stepName: "S2", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
  ],
};

describe("runs controller", () => {
  let container: StartedPostgreSqlContainer;
  let ctx: TestContext;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    ctx = await createTestApp(container);

    // Seed a published definition
    await new DefinitionRepository(ctx.db).create({
      tenantId: "default", name: "test-wf", version: "1.0.0",
      definition: simpleDef as never,
      status: WorkflowDefinitionStatus.PUBLISHED,
    });
  });

  afterAll(async () => {
    await ctx.cleanup();
    await container.stop();
  });

  it("POST /runs starts a workflow run", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "test-wf", version: "1.0.0", inputs: { foo: "bar" } });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("runId");
    expect(res.body).toHaveProperty("status");
  });

  it("POST /runs respects Idempotency-Key", async () => {
    const body = { name: "test-wf", version: "1.0.0", inputs: { idem: 1 } };
    const r1 = await request(ctx.app)
      .post("/api/v1/runs")
      .set("idempotency-key", "key-1")
      .send(body);
    const r2 = await request(ctx.app)
      .post("/api/v1/runs")
      .set("idempotency-key", "key-1")
      .send(body);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r1.body.runId).toBe(r2.body.runId);
  });

  it("GET /runs lists runs", async () => {
    const res = await request(ctx.app).get("/api/v1/runs");
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
    expect(res.body).toHaveProperty("total");
  });

  it("GET /runs/:id returns a run with steps", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "test-wf", version: "1.0.0", inputs: {} });
    const res = await request(ctx.app).get(`/api/v1/runs/${created.body.runId}`);

    expect(res.status).toBe(200);
    expect(res.body.stepRuns).toBeDefined();
    expect(res.body.stepRuns.length).toBe(2);
  });

  it("POST /runs/search performs jsonb search", async () => {
    await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "test-wf", version: "1.0.0", inputs: { searchKey: "unique-value-123" } });

    const res = await request(ctx.app)
      .post("/api/v1/runs/search")
      .send({ filter: { "inputs.searchKey": "unique-value-123" } });

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /runs/by-ids returns specific runs", async () => {
    const r1 = await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "test-wf", version: "1.0.0", inputs: {} });
    const r2 = await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "test-wf", version: "1.0.0", inputs: {} });

    const res = await request(ctx.app)
      .post("/api/v1/runs/by-ids")
      .send({ ids: [r1.body.runId, r2.body.runId] });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  it("PUT /runs/:id/cancel cancels a run", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "test-wf", version: "1.0.0", inputs: {} });

    const res = await request(ctx.app).put(`/api/v1/runs/${created.body.runId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("PUT /runs/:id/restart/step/:n restarts from a step", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "test-wf", version: "1.0.0", inputs: {} });

    // Wait for the run to complete
    await new Promise((r) => setTimeout(r, 500));

    const res = await request(ctx.app).put(`/api/v1/runs/${created.body.runId}/restart/step/0`);
    expect(res.status).toBe(200);
  });

  it("PUT /runs/:id/callback resumes a parked step", async () => {
    // Seed a definition with an external task step
    await new DefinitionRepository(ctx.db).create({
      tenantId: "default", name: "cb-wf", version: "1.0.0",
      definition: {
        steps: [
          { stepName: "Ext", stepVersion: "1.0.0", stepType: "core.externalTask", externalServiceName: "svc", stepInputs: [] },
          { stepName: "End", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
        ],
      } as never,
      status: WorkflowDefinitionStatus.PUBLISHED,
    });

    const created = await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "cb-wf", version: "1.0.0", inputs: {} });

    // Wait for step to park
    await new Promise((r) => setTimeout(r, 500));

    const res = await request(ctx.app)
      .put(`/api/v1/runs/${created.body.runId}/callback`)
      .send({ stepNumber: 0, body: { result: "done" } });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("complete");
  });

  it("PUT /runs/:id/inputs updates run inputs", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "test-wf", version: "1.0.0", inputs: { old: true } });

    const res = await request(ctx.app)
      .put(`/api/v1/runs/${created.body.runId}/inputs`)
      .send({ inputs: { updated: true } });

    expect(res.status).toBe(200);
    expect(res.body.inputs).toMatchObject({ updated: true });
  });

  it("returns 404 for a non-existent run", async () => {
    const res = await request(ctx.app).get("/api/v1/runs/99999");
    expect(res.status).toBe(404);
  });
});
