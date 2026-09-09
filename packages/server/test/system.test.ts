import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import request from "supertest";
import { createTestApp, TestContext } from "./helpers";

jest.setTimeout(120000);

describe("system endpoints", () => {
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

  it("GET /health returns ok", async () => {
    const res = await request(ctx.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /api/v1/health returns ok", async () => {
    const res = await request(ctx.app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /api/v1/version returns a version string", async () => {
    const res = await request(ctx.app).get("/api/v1/version");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("version");
  });

  it("sets X-Request-Id on every response", async () => {
    const res = await request(ctx.app).get("/health");
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("echoes back a client-supplied X-Request-Id", async () => {
    const res = await request(ctx.app).get("/health").set("x-request-id", "abc-123");
    expect(res.headers["x-request-id"]).toBe("abc-123");
  });
});
