import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
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

    // Imported dynamically, and only after mswServer.close() above:
    // @testcontainers/postgresql's transitive dependency chain (dockerode ->
    // docker-modem -> ssh2) includes ssh2's bundled Poly1305 WASM crypto
    // module, which calls fetch() on a data: URI at module-evaluation time.
    // A static top-level import would evaluate that chain before this
    // beforeAll ever runs, so the fetch would fire while MSW is still
    // listening and get logged as a spurious "unhandled request" error.
    // Deferring the import to here, after MSW is stood down, means that
    // module-level fetch never reaches MSW's interceptor at all.
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");

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
    // beforeAll can fail partway through (container start, migrations,
    // definition seeding, ...), and Vitest still runs this hook when it
    // does. Each step below is independently guarded so that one failure —
    // or one resource never having been assigned — cannot suppress the
    // others: in particular, a failed `db.close()` must not skip
    // `container.stop()` and leak a running Postgres container, and nothing
    // here may skip restoring MSW.
    const errors: unknown[] = [];
    const guard = async (fn: () => Promise<unknown> | unknown) => {
      try {
        await fn();
      } catch (err) {
        errors.push(err);
      }
    };

    try {
      await guard(() => (server ? new Promise<void>((res) => server.close(() => res())) : undefined));
      await guard(() => evaluator?.dispose());
      await guard(() => queue?.close());
      await guard(() => db?.close());
      await guard(() => container?.stop());
    } finally {
      // Restore MSW regardless of what happened above: a failed teardown
      // step must not also leave every later test file in this Vitest run
      // silently talking to the real network instead of MSW.
      mswServer.listen({ onUnhandledRequest: "error" });
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "one or more afterAll cleanup steps failed");
    }
  });

  it("GET /step-types returns the built-in registry", async () => {
    const { data, response } = await client.GET("/api/v1/step-types", {});
    expect(response.status).toBe(200);
    const types = data!.map((t) => t.type);
    expect(types).toContain("core.noop");
    expect(types).toContain("core.http");
  });

  it("GET /filter-configuration returns registry-backed stepType values", async () => {
    const { data } = await client.GET("/api/v1/filter-configuration", {});
    const stepType = data!.steps.find((f) => f.field === "stepType");
    // Sourced from the live registry, so this fails if the endpoint ever
    // reverts to a hardcoded list that omits a real step type.
    expect(stepType?.values).toContain("core.transform");
  });

  it("GET /runs lists the run that was started", async () => {
    const { data } = await client.GET("/api/v1/runs", {});
    expect(data!.total).toBeGreaterThanOrEqual(1);
    expect(data!.rows.some((r) => r.id === runId)).toBe(true);
  });

  it("GET /runs/{id} returns the run with its steps", async () => {
    const { data } = await client.GET("/api/v1/runs/{id}", { params: { path: { id: runId } } });
    expect(data!.id).toBe(runId);
    expect(data!.stepRuns!.map((s) => s.stepName)).toEqual(["Only"]);
  });

  it("GET /definitions lists the published definition", async () => {
    const { data } = await client.GET("/api/v1/definitions", {});
    expect(data!.rows.some((d) => d.name === "contract-target" && d.version === "1.0.0")).toBe(true);
  });

  it("surfaces a server error envelope with its code", async () => {
    const { error, response } = await client.GET("/api/v1/runs/{id}", { params: { path: { id: 999999 } } });
    expect(response.status).toBe(404);
    expect(error!.error.code).toBe("RUN_NOT_FOUND");
  });
});
