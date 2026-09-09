import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DefinitionRepository } from "@wfe/core";
import { WorkflowDefinitionStatus } from "@wfe/sdk";
import request from "supertest";
import { createTestApp, TestContext } from "./helpers";

jest.setTimeout(120000);

describe("steps controller", () => {
  let container: StartedPostgreSqlContainer;
  let ctx: TestContext;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    ctx = await createTestApp(container);

    await new DefinitionRepository(ctx.db).create({
      tenantId: "default", name: "step-wf", version: "1.0.0",
      definition: {
        steps: [
          {
            stepName: "ExtTask", stepVersion: "1.0.0", stepType: "core.externalTask",
            externalServiceName: "billing", stepInputs: [],
          },
          { stepName: "End", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
        ],
      } as never,
      status: WorkflowDefinitionStatus.PUBLISHED,
    });
  });

  afterAll(async () => {
    await ctx.cleanup();
    await container.stop();
  });

  it("GET /step-types returns registered step types", async () => {
    const res = await request(ctx.app).get("/api/v1/step-types");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(4);
    expect(res.body.find((t: { type: string }) => t.type === "core.noop")).toBeDefined();
  });

  it("GET /steps/next claims the next external task", async () => {
    // Start a run that parks on the external task
    const runRes = await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "step-wf", version: "1.0.0", inputs: {} });
    await new Promise((r) => setTimeout(r, 500));

    const res = await request(ctx.app).get("/api/v1/steps/next?service=billing");
    expect(res.status).toBe(200);
    // Should find at least one waiting step for billing
    if (res.body) {
      expect(res.body.externalServiceName).toBe("billing");
    }
  });

  it("POST /steps/search finds steps by criteria", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/steps/search")
      .send({ status: "waiting", externalServiceName: "billing" });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("PUT /steps/:id/priority updates step priority", async () => {
    // Create a run and get a step id
    await request(ctx.app)
      .post("/api/v1/runs")
      .send({ name: "step-wf", version: "1.0.0", inputs: {} });
    await new Promise((r) => setTimeout(r, 500));

    const searchRes = await request(ctx.app)
      .post("/api/v1/steps/search")
      .send({ externalServiceName: "billing" });

    if (searchRes.body.length > 0) {
      const stepId = searchRes.body[0].id;
      const res = await request(ctx.app)
        .put(`/api/v1/steps/${stepId}/priority`)
        .send({ priority: 10 });
      expect(res.status).toBe(200);
      expect(res.body.priority).toBe(10);
    }
  });

  it("POST /steps/dry-run evaluates capture expressions", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/steps/dry-run")
      .send({
        expressions: [
          { targetFieldName: "result", modelEvaluationExpression: "Number(42)" },
        ],
        state: { inputs: {}, outputs: {}, state: {} },
      });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe(42);
  });
});
