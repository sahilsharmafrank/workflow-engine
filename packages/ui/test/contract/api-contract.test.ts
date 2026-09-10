import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  DbContext, DefinitionRepository, ExpressionEvaluator, MemoryQueueDriver,
  RunExecutor, StepRegistry, registerBuiltInSteps, validateDefinitionShape,
} from "@wfe/core";
import { NoneAuthProvider, createApp } from "@wfe/server";
import { WorkflowDefinitionStatus } from "@wfe/sdk";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import createClient from "openapi-fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { paths } from "../../src/api/schema";
import { mswServer } from "../msw/server";

describe("generated client against a real server", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbContext;
  let evaluator: ExpressionEvaluator;
  let queue: MemoryQueueDriver;
  let server: Server;
  let client: ReturnType<typeof createClient<paths>>;
  let runId: number;

  beforeAll(async () => {
    // MSW would intercept these requests; this suite exists precisely to avoid
    // mocks, so stand it down for the duration.
    mswServer.close();

    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const config = { dbUrl: container.getConnectionUri() };
    db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
    queue = new MemoryQueueDriver();
    const executor = new RunExecutor({ config, db, registry, evaluator, queue });

    const defs = new DefinitionRepository(db);
    const body = await validateDefinitionShape({
      steps: [{ stepName: "Only", stepVersion: "1.0.0", stepType: "core.transform", stepInputs: [] }],
    });
    await defs.create({
      tenantId: "default", name: "contract-target", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED, definition: body,
    });

    const app = createApp({
      executor, db, registry, evaluator, queue,
      authProvider: new NoneAuthProvider(),
    });
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    client = createClient<paths>({ baseUrl: `http://127.0.0.1:${port}` });

    runId = await executor.startWorkflow({
      tenantId: "default", name: "contract-target", version: "1.0.0", inputs: {},
    });
    await executor.start("default", runId);
  }, 180000);

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    evaluator.dispose();
    await queue.close();
    await db.close();
    await container.stop();
    mswServer.listen({ onUnhandledRequest: "error" });
  });

  it("GET /step-types returns the built-in registry", async () => {
    const { data, response } = await client.GET("/api/v1/step-types", {});
    expect(response.status).toBe(200);
    const types = (data as Array<{ type: string }>).map((t) => t.type);
    expect(types).toContain("core.noop");
    expect(types).toContain("core.http");
  });

  it("GET /filter-configuration returns registry-backed stepType values", async () => {
    const { data } = await client.GET("/api/v1/filter-configuration", {});
    const cfg = data as unknown as { steps: Array<{ field: string; values?: string[] }> };
    const stepType = cfg.steps.find((f) => f.field === "stepType");
    // Sourced from the live registry, so this fails if the endpoint ever
    // reverts to a hardcoded list that omits a real step type.
    expect(stepType?.values).toContain("core.transform");
  });

  it("GET /runs lists the run that was started", async () => {
    const { data } = await client.GET("/api/v1/runs", {});
    const result = data as unknown as { rows: Array<{ id: number; name: string }>; total: number };
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.rows.some((r) => r.id === runId)).toBe(true);
  });

  it("GET /runs/{id} returns the run with its steps", async () => {
    const { data } = await client.GET("/api/v1/runs/{id}", { params: { path: { id: runId } } });
    const run = data as unknown as { id: number; status: string; stepRuns: Array<{ stepName: string }> };
    expect(run.id).toBe(runId);
    expect(run.stepRuns.map((s) => s.stepName)).toEqual(["Only"]);
  });

  it("GET /definitions lists the published definition", async () => {
    const { data } = await client.GET("/api/v1/definitions", {});
    const result = data as unknown as { rows: Array<{ name: string; version: string }> };
    expect(result.rows.some((d) => d.name === "contract-target" && d.version === "1.0.0")).toBe(true);
  });

  it("surfaces a server error envelope with its code", async () => {
    const { error, response } = await client.GET("/api/v1/runs/{id}", { params: { path: { id: 999999 } } });
    expect(response.status).toBe(404);
    expect((error as unknown as { error: { code: string } }).error.code).toBe("RUN_NOT_FOUND");
  });
});
