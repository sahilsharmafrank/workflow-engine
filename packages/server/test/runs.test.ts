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

    // Same definition under a second tenant, for the cross-tenant search
    // isolation test below.
    await new DefinitionRepository(ctx.db).create({
      tenantId: "tenant-b", name: "test-wf", version: "1.0.0",
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

  it("POST /runs/search rejects a filter key crafted to break out of the identifier position", async () => {
    // `column` from a filter key like "inputs.foo" is spliced directly into
    // a raw SQL identifier (`r.${column}Json`) inside RunRepository.search,
    // with no escaping. Verified against the actual generated SQL (see the
    // next test): this key turns the query's WHERE clause into
    // `(r.tenant_id = $1 AND r.id > 0) OR id = id OR inputs_json @> $2` —
    // an unconditional tautology (`id = id`) sitting in its own OR branch,
    // entirely outside the tenant filter — which returns every tenant's runs.
    const res = await request(ctx.app)
      .post("/api/v1/runs/search")
      .send({ filter: { "id > 0 OR id = id OR inputs_.x": "anything" } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("RUN_SEARCH_INVALID_FILTER_KEY");
  });

  it("POST /runs/search never returns another tenant's runs, even via the crafted bypass key", async () => {
    // A second tenant's run, with an input value that would stand out if it
    // leaked into tenant "default"'s search results.
    const otherTenantRun = await request(ctx.app)
      .post("/api/v1/runs")
      .set("X-Tenant-Id", "tenant-b")
      .send({ name: "test-wf", version: "1.0.0", inputs: { marker: "tenant-b-secret" } });
    expect(otherTenantRun.status).toBe(201);

    const res = await request(ctx.app)
      .post("/api/v1/runs/search")
      // Tenant "default" (the default when no X-Tenant-Id header is sent)
      // submits the same OR-based bypass key from the test above. Against
      // the current code this genuinely returns 200 with tenant-b's run
      // included (verified directly against the generated SQL) — this is
      // not a hypothetical, it's the exact reachable exploit.
      .send({ filter: { "id > 0 OR id = id OR inputs_.x": "anything" } });

    // The fixed behaviour rejects the key outright with 400, so there is no
    // body to leak through. Assert the invariant directly rather than the
    // mechanism: tenant-b's run must never come back, whatever the status.
    const leaked = res.status === 200
      && (res.body as Array<{ tenantId?: string }>).some((run) => run.tenantId === "tenant-b");
    expect(leaked).toBe(false);
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
    // "test-wf" is two core.noop steps, which complete synchronously — by
    // the time this request lands the run could already be COMPLETE, and
    // cancel() now (correctly) refuses to cancel a terminal run. Use a
    // definition that parks in WAITING so the run is genuinely still
    // cancellable when this test calls cancel.
    await new DefinitionRepository(ctx.db).create({
      tenantId: "default", name: "cancel-wf", version: "1.0.0",
      definition: {
        steps: [
          { stepName: "Ext", stepVersion: "1.0.0", stepType: "core.externalTask", externalServiceName: "svc", stepInputs: [] },
        ],
      } as never,
      status: WorkflowDefinitionStatus.PUBLISHED,
    });

    const created = await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "cancel-wf", version: "1.0.0", inputs: {} });

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
