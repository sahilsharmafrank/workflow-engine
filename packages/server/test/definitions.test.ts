import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import request from "supertest";
import { createTestApp, TestContext } from "./helpers";

jest.setTimeout(120000);

const validDefinition = {
  steps: [
    { stepName: "S1", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
  ],
};

describe("definitions controller", () => {
  let container: StartedPostgreSqlContainer;
  let ctx: TestContext;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    ctx = await createTestApp(container);
  });

  afterAll(async () => {
    await ctx.cleanup();
    await container.stop();
  });

  it("POST /definitions creates a draft definition", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/definitions")
      .send({ name: "test-def", version: "1.0.0", definition: validDefinition });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "test-def", version: "1.0.0", status: "draft" });
    expect(res.body.id).toBeDefined();
  });

  it("GET /definitions lists definitions", async () => {
    const res = await request(ctx.app).get("/api/v1/definitions");
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
    expect(res.body).toHaveProperty("total");
  });

  it("GET /definitions/:id returns a single definition", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/definitions")
      .send({ name: "get-test", version: "1.0.0", definition: validDefinition });

    const res = await request(ctx.app).get(`/api/v1/definitions/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("get-test");
  });

  it("PUT /definitions/:id updates and preserves history", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/definitions")
      .send({ name: "upd-test", version: "1.0.0", definition: validDefinition });

    const newDef = {
      steps: [
        { stepName: "S1", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
        { stepName: "S2", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
      ],
    };
    const res = await request(ctx.app)
      .put(`/api/v1/definitions/${created.body.id}`)
      .send({ definition: newDef });

    expect(res.status).toBe(200);
    expect(res.body.definition.steps).toHaveLength(2);
    expect(res.body.lastUpdateHistory).toBeDefined();
  });

  it("POST /definitions/:id/publish transitions draft to published", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/definitions")
      .send({ name: "pub-test", version: "1.0.0", definition: validDefinition });

    const res = await request(ctx.app).post(`/api/v1/definitions/${created.body.id}/publish`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("published");
  });

  it("POST /definitions/:id/publish transitions published to archived", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/definitions")
      .send({ name: "arc-test", version: "1.0.0", definition: validDefinition });

    await request(ctx.app).post(`/api/v1/definitions/${created.body.id}/publish`);
    const res = await request(ctx.app).post(`/api/v1/definitions/${created.body.id}/publish`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("archived");
  });

  it("POST /definitions/import creates multiple definitions", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/definitions/import")
      .send([
        { name: "imp-1", version: "1.0.0", definition: validDefinition },
        { name: "imp-2", version: "1.0.0", definition: validDefinition },
      ]);

    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(2);
  });

  it("rejects an invalid definition shape", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/definitions")
      .send({ name: "bad", version: "1.0.0", definition: { steps: [] } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("DEFINITION_INVALID");
  });

  it("rejects a definition with an unknown step type", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/definitions")
      .send({
        name: "bad-type", version: "1.0.0",
        definition: { steps: [{ stepName: "X", stepVersion: "1.0.0", stepType: "bogus", stepInputs: [] }] },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("DEFINITION_UNKNOWN_STEP_TYPE");
  });

  it("GET /definitions supports status filter", async () => {
    const res = await request(ctx.app).get("/api/v1/definitions?status=published");
    expect(res.status).toBe(200);
    for (const row of res.body.rows) {
      expect(row.status).toBe("published");
    }
  });

  it("returns 404 for a non-existent definition", async () => {
    const res = await request(ctx.app).get("/api/v1/definitions/99999");
    expect(res.status).toBe(404);
  });
});
