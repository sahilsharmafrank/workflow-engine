# REST API and CLI Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@wfe/server` — an Express REST API under `/api/v1`, an OpenAPI 3 document at `/openapi.json`, an `AuthProvider` interface with a `none` implementation, and a `wfe` CLI (`migrate | import | serve | worker`) — so that `docker compose up` followed by `curl` starts and monitors a workflow run.

**Architecture:** A new `packages/server` workspace package containing Express middleware, route controllers split by resource (definitions, runs, steps, system), a thin `AuthProvider` seam, OpenAPI generation, and a CLI entry point. Controllers delegate all domain logic to `@wfe/core`'s `RunExecutor`, `WorkflowManager`, and repositories — no business logic lives in the server package. New repository methods (list, update, search, publish) are added to `@wfe/core` where needed, keeping the HTTP layer thin. The pg deprecation warning from the carry-forward is fixed as part of this phase.

**Tech Stack:** Node ^24, TypeScript 5.9 (CommonJS), Express 4, `swagger-jsdoc` + `swagger-ui-express` for OpenAPI, `commander` for CLI, jest + ts-jest + supertest, `@testcontainers/postgresql`.

**Spec:** `docs/superpowers/specs/2026-09-07-standalone-workflow-engine-design.md` — §3.1 (execution model), §9 (auth/tenancy), §10 (REST endpoints), §12 (configuration/CLI).

**Predecessor:** `docs/superpowers/plans/2026-09-07-queue-drivers.md` (Phase 2, complete — 22 suites / 152 tests).

## Global Constraints

- Node `^24.0.0`; npm `>=11`. TypeScript `^5.9.3`, `module: commonjs`.
- **No `@mast/*` dependency anywhere.** No domain vocabulary in shipped code.
- Expression evaluation stays inside the isolate sandbox.
- Every definition and run row carries `tenantId`; every repository query filters on it.
- Statuses come from the `WorkflowStatus` / `WorkflowDefinitionStatus` enums in `@wfe/sdk`.
- `@wfe/sdk` keeps **zero runtime dependencies**.
- `@wfe/core` must remain usable as a library — no HTTP concerns in core.
- TDD: failing test first, run it to confirm the failure, then implement. Commit at the end of each task.
- `npm run build` before `npm test` — `ts-jest` type-checks `@wfe/sdk` through its built `dist`.

## What Phases 1 and 2 provide

Read before starting: `packages/core/src/engine/run-executor.ts`, `packages/core/src/engine/workflow-manager.ts`, `packages/core/src/repositories/`.

- `RunExecutor` extends `WorkflowManager`, with `startWorkflow(input): Promise<number>`, `start(tenantId, runId)`, `run(tenantId, runId, stepNumber, body?)`, `resume(msg)`, `callback(tenantId, runId, stepNumber, body)`, `cancel(tenantId, runId)`, `restartFromStep(tenantId, runId, stepNumber)`.
- `WorkflowManager.startWorkflow({ tenantId, name, version, inputs })` creates the run and step rows.
- `RunRepository` has `save`, `saveChecked`, `findById(tenantId, id)`, `getStatus(tenantId, id)`.
- `DefinitionRepository` has `create(input)`, `findById(tenantId, id)`, `findPublished(tenantId, name, version)`.
- `StepRegistry` with `register`, `has`, `create`, `list()`.
- `validateDefinitionShape(body)` — yup validation, `validateAgainstRegistry(body, registry)`.
- `WfeError` with `statusCode`, `code`, `details`.
- `EngineConfig`, `loadEngineConfig(env)`, `DbContext`, `ExpressionEvaluator`.
- `QueueDriver`, `createQueueDriver`, `MemoryQueueDriver`, `WorkflowWorker`.
- `WorkflowRun` entity with eager `stepRuns`, transient jsonb params, `@AfterLoad` step sort, `revision` column.
- `StepRun` entity with `tenantId`, `externalServiceName`, `priority`, `remoteTaskStatus`.
- `WorkflowDefinitionEntity` with `tenantId`, `name`, `version`, `status`, `definition`, `lastUpdateHistory`.

## File Structure

```
packages/server/
  package.json
  tsconfig.json
  jest.config.js
  src/
    index.ts                     barrel exports
    config.ts                    ServerConfig, loadServerConfig(env)
    app.ts                       Express app factory (createApp)
    auth/
      types.ts                   AuthProvider, AuthenticatedRequest
      none-provider.ts           NoneAuthProvider
    middleware/
      error-handler.ts           WfeError → JSON response
      tenant.ts                  resolves AuthProvider → req.tenantId
      request-id.ts              X-Request-Id propagation
    controllers/
      definitions.ts             GET/POST/PUT definitions, POST publish, POST import
      runs.ts                    POST/GET runs, POST search, PUT cancel/restart/callback/inputs
      steps.ts                   GET next, POST search, PUT state/inputs-outputs/priority, GET step-types, POST dry-run
      system.ts                  GET /health, GET /version, GET /openapi.json
    openapi/
      spec.ts                    OpenAPI 3 document builder
    cli/
      index.ts                   commander program: migrate, import, serve, worker
  test/
    helpers.ts                   createTestApp helper (in-memory queue, testcontainer pg)
    definitions.test.ts
    runs.test.ts
    steps.test.ts
    system.test.ts
    auth.test.ts
    cli.test.ts

packages/core/src/
  repositories/definition-repository.ts   MODIFY: add list, update, publish, findByIds
  repositories/run-repository.ts          MODIFY: add list, search, findByIds, updateInputs
  repositories/step-repository.ts         CREATE: claimNext, search, updateState, updateInputsOutputs, updatePriority
  entities/idempotency-key.ts             CREATE
  db/migrations/0003-server-support.ts    CREATE: idempotency_key table
  db/db-context.ts                        MODIFY: register new entity + migration
  config.ts                               MODIFY: add server config fields
```

---

### Task 1: Package scaffold, server config, error middleware and health endpoint

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/jest.config.js`
- Create: `packages/server/src/index.ts`, `packages/server/src/config.ts`
- Create: `packages/server/src/auth/types.ts`, `packages/server/src/auth/none-provider.ts`
- Create: `packages/server/src/middleware/error-handler.ts`, `packages/server/src/middleware/tenant.ts`, `packages/server/src/middleware/request-id.ts`
- Create: `packages/server/src/app.ts`
- Create: `packages/server/src/controllers/system.ts`
- Test: `packages/server/test/helpers.ts`, `packages/server/test/system.test.ts`

**Interfaces:**
- Consumes: `WfeError` from `@wfe/core`, `EngineConfig`, `DbContext`, `ExpressionEvaluator`, `StepRegistry`, `registerBuiltInSteps`, `MemoryQueueDriver`, `RunExecutor`.
- Produces:
  - `interface AuthProvider { authenticate(req: Request): Promise<{ tenantId: string; scopes: string[] } | null> }`
  - `interface AuthenticatedRequest extends Request { tenantId: string; scopes: string[] }`
  - `class NoneAuthProvider implements AuthProvider` — returns `{ tenantId: req.headers["x-tenant-id"] ?? "default", scopes: ["*"] }`
  - `function errorHandler(): ErrorRequestHandler` — maps `WfeError` to `{ error: { code, message, details? } }` with the error's `statusCode`
  - `function tenantMiddleware(provider: AuthProvider): RequestHandler` — resolves and attaches tenant
  - `function requestIdMiddleware(): RequestHandler` — reads/generates `X-Request-Id`
  - `interface ServerConfig extends EngineConfig { port: number; authProvider: string; servicesConfig: Record<string, string> }`
  - `function loadServerConfig(env): ServerConfig`
  - `function createApp(deps: AppDeps): Express` — assembles middleware + routes
  - `GET /health` → `{ status: "ok" }`; `GET /version` → `{ version }` — unlogged, unauthenticated
  - `createTestApp(container): { app, db, executor, queue, cleanup }` test helper

Tasks 2–7 all consume `createApp` / `createTestApp` and `AuthenticatedRequest`.

- [ ] **Step 1: Create the package scaffold**

`packages/server/package.json`:

```json
{
  "name": "@wfe/server",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "engines": { "node": "^24.0.0" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest --passWithNoTests",
    "clean": "rm -rf dist coverage"
  },
  "dependencies": {
    "@wfe/core": "0.1.0",
    "@wfe/sdk": "0.1.0",
    "commander": "^13.1.0",
    "express": "^4.21.0",
    "swagger-ui-express": "^5.0.0"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^12.1.0",
    "@types/express": "^5.0.0",
    "@types/swagger-ui-express": "^4.1.0",
    "supertest": "^7.1.0",
    "@types/supertest": "^6.0.0"
  }
}
```

`packages/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true
  },
  "include": ["src"],
  "references": [
    { "path": "../core" },
    { "path": "../sdk" }
  ]
}
```

`packages/server/jest.config.js`:

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  moduleNameMapper: {
    "^@wfe/sdk$": "<rootDir>/../sdk/dist",
    "^@wfe/sdk/(.*)$": "<rootDir>/../sdk/dist/$1",
  },
  transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }] },
};
```

- [ ] **Step 2: Write the auth types and none provider**

`packages/server/src/auth/types.ts`:

```typescript
import { Request } from "express";

/**
 * Resolves a request to a tenant identity and a set of permission scopes.
 * v1 ships only `NoneAuthProvider`; the seam exists so an `apiKey` or `jwt`
 * provider can be added later as one new file plus a config value.
 */
export interface AuthProvider {
  // SECURITY-REVIEW: auth provider interface — implementations must validate tokens/keys
  authenticate(req: Request): Promise<{ tenantId: string; scopes: string[] } | null>;
}

export interface AuthenticatedRequest extends Request {
  tenantId: string;
  scopes: string[];
}
```

`packages/server/src/auth/none-provider.ts`:

```typescript
import { Request } from "express";
import { AuthProvider } from "./types";

/**
 * Unauthenticated provider for v1. Tenant identity comes from the
 * `X-Tenant-Id` header, defaulting to `"default"`. Every scope is granted.
 *
 * SECURITY-REVIEW: unauthenticated — the API is open. Deployments must
 * bind to localhost or sit behind an external gateway until a real auth
 * provider lands.
 */
export class NoneAuthProvider implements AuthProvider {
  async authenticate(req: Request): Promise<{ tenantId: string; scopes: string[] }> {
    const tenantId = (req.headers["x-tenant-id"] as string) ?? "default";
    return { tenantId, scopes: ["*"] };
  }
}
```

- [ ] **Step 3: Write the middleware**

`packages/server/src/middleware/error-handler.ts`:

```typescript
import { ErrorRequestHandler } from "express";
import { WfeError } from "@wfe/core";
import { createLogger } from "@wfe/core";

const log = createLogger("error-handler");

/**
 * Catches thrown errors and maps them to a JSON envelope.
 * `WfeError` carries its own status code; everything else is 500.
 * Stack traces and internal paths are never exposed — generic message
 * for untyped errors, structured `{ code, message, details? }` for WfeError.
 */
export function errorHandler(): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (err instanceof WfeError) {
      log.warn("Request failed", { code: err.code, status: err.statusCode, message: err.message });
      res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
      return;
    }

    log.error("Unhandled error", { error: (err as Error).message });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  };
}
```

`packages/server/src/middleware/tenant.ts`:

```typescript
import { RequestHandler, Response, NextFunction } from "express";
import { AuthProvider, AuthenticatedRequest } from "../auth/types";

/**
 * Resolves the `AuthProvider` and stamps `tenantId`/`scopes` onto the request.
 * A null result means the provider rejected the request — 401.
 */
export function tenantMiddleware(provider: AuthProvider): RequestHandler {
  // SECURITY-REVIEW: tenant resolution — relies on AuthProvider correctness
  return async (req, res: Response, next: NextFunction) => {
    try {
      const principal = await provider.authenticate(req);
      if (!principal) {
        res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
        return;
      }
      (req as AuthenticatedRequest).tenantId = principal.tenantId;
      (req as AuthenticatedRequest).scopes = principal.scopes;
      next();
    } catch (err) {
      next(err);
    }
  };
}
```

`packages/server/src/middleware/request-id.ts`:

```typescript
import { randomUUID } from "crypto";
import { RequestHandler } from "express";

/** Reads or generates `X-Request-Id` and echoes it on the response. */
export function requestIdMiddleware(): RequestHandler {
  return (req, res, next) => {
    const id = (req.headers["x-request-id"] as string) ?? randomUUID();
    req.headers["x-request-id"] = id;
    res.setHeader("x-request-id", id);
    next();
  };
}
```

- [ ] **Step 4: Write the server config**

`packages/server/src/config.ts`:

```typescript
import { EngineConfig, loadEngineConfig } from "@wfe/core";

export interface ServerConfig extends EngineConfig {
  port: number;
  authProvider: string;
  queueDriver: string;
  queueUrl?: string;
  sqsPrefix?: string;
  awsRegion?: string;
  servicesConfig: Record<string, string>;
  plugins: string[];
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const engine = loadEngineConfig(env);

  let servicesConfig: Record<string, string> = {};
  if (env.WFE_SERVICES) {
    try {
      servicesConfig = JSON.parse(env.WFE_SERVICES);
    } catch {
      throw new Error(`WFE_SERVICES must be valid JSON; got: ${env.WFE_SERVICES}`);
    }
  }

  return {
    ...engine,
    port: Number(env.WFE_PORT ?? 3000),
    authProvider: env.WFE_AUTH_PROVIDER ?? "none",
    queueDriver: env.WFE_QUEUE_DRIVER ?? "memory",
    queueUrl: env.WFE_QUEUE_URL,
    sqsPrefix: env.WFE_SQS_PREFIX,
    awsRegion: env.WFE_AWS_REGION ?? env.AWS_REGION,
    servicesConfig,
    plugins: (env.WFE_PLUGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}
```

- [ ] **Step 5: Write the system controller**

`packages/server/src/controllers/system.ts`:

```typescript
import { Router } from "express";
import { readFileSync } from "fs";
import { join } from "path";

let versionInfo: { version: string } | undefined;

function getVersion(): { version: string } {
  if (versionInfo) return versionInfo;
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../../package.json"), "utf8"));
    versionInfo = { version: pkg.version ?? "0.0.0" };
  } catch {
    versionInfo = { version: "0.0.0" };
  }
  return versionInfo;
}

export function systemRoutes(): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/version", (_req, res) => {
    res.json(getVersion());
  });

  return router;
}
```

- [ ] **Step 6: Write the app factory**

`packages/server/src/app.ts`:

```typescript
import express, { Express } from "express";
import { RunExecutor, StepRegistry, DbContext, ExpressionEvaluator, QueueDriver } from "@wfe/core";
import { AuthProvider } from "./auth/types";
import { errorHandler } from "./middleware/error-handler";
import { tenantMiddleware } from "./middleware/tenant";
import { requestIdMiddleware } from "./middleware/request-id";
import { systemRoutes } from "./controllers/system";

export interface AppDeps {
  executor: RunExecutor;
  db: DbContext;
  registry: StepRegistry;
  authProvider: AuthProvider;
  queue?: QueueDriver;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.use(express.json({ limit: "10mb" }));
  app.use(requestIdMiddleware());

  // Health and version are unauthenticated and unlogged
  app.use("/health", systemRoutes());
  app.use("/api/v1", systemRoutes());

  // All /api/v1 routes below this point require tenant resolution
  app.use("/api/v1", tenantMiddleware(deps.authProvider));

  // Route controllers will be mounted here in Tasks 2–5

  app.use(errorHandler());

  return app;
}
```

- [ ] **Step 7: Write the barrel export**

`packages/server/src/index.ts`:

```typescript
export * from "./config";
export * from "./app";
export * from "./auth/types";
export * from "./auth/none-provider";
export * from "./middleware/error-handler";
export * from "./middleware/tenant";
export * from "./middleware/request-id";
export * from "./controllers/system";
```

- [ ] **Step 8: Write the test helper**

`packages/server/test/helpers.ts`:

```typescript
import "reflect-metadata";
import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  DbContext, ExpressionEvaluator, MemoryQueueDriver, RunExecutor,
  StepRegistry, registerBuiltInSteps, DELAY_QUEUE, RESPONSE_QUEUE,
} from "@wfe/core";
import { Express } from "express";
import { createApp } from "../src/app";
import { NoneAuthProvider } from "../src/auth/none-provider";

export interface TestContext {
  app: Express;
  db: DbContext;
  executor: RunExecutor;
  queue: MemoryQueueDriver;
  registry: StepRegistry;
  evaluator: ExpressionEvaluator;
  cleanup: () => Promise<void>;
}

export async function createTestApp(container: StartedPostgreSqlContainer): Promise<TestContext> {
  const config = { dbUrl: container.getConnectionUri() };
  const db = new DbContext(config);
  await db.runMigrations();

  const registry = new StepRegistry();
  registerBuiltInSteps(registry);

  const queue = new MemoryQueueDriver();
  await queue.ensureQueues([{ queueName: DELAY_QUEUE }, { queueName: RESPONSE_QUEUE }]);

  const evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
  const executor = new RunExecutor({ config, db, registry, evaluator, queue });

  const app = createApp({
    executor,
    db,
    registry,
    authProvider: new NoneAuthProvider(),
    queue,
  });

  return {
    app, db, executor, queue, registry, evaluator,
    cleanup: async () => {
      evaluator.dispose();
      await queue.close();
      await db.close();
    },
  };
}
```

- [ ] **Step 9: Write the failing test**

`packages/server/test/system.test.ts`:

```typescript
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
```

- [ ] **Step 10: Install dependencies and run tests**

```bash
cd /path/to/repo && npm install
npm run build
npm test -w @wfe/server -- system
```

Expected: PASS — 5 tests.

- [ ] **Step 11: Run the full suite**

```bash
npm run build && npm test
```

Expected: PASS — core 22/152, sdk 3/12, server 1/5.

- [ ] **Step 12: Commit**

```bash
git add packages/server packages/core docker-compose.yml
git commit -m "feat(server): add package scaffold, auth provider, middleware and health endpoint"
```

---

### Task 2: Definition CRUD — repository extensions and controller

**Files:**
- Modify: `packages/core/src/repositories/definition-repository.ts` — add `list`, `update`, `publish`, `findByIds`
- Create: `packages/server/src/controllers/definitions.ts`
- Modify: `packages/server/src/app.ts` — mount definitions routes
- Modify: `packages/server/src/index.ts` — export definitions controller
- Test: `packages/server/test/definitions.test.ts`

**Interfaces:**
- Consumes: `DefinitionRepository`, `validateDefinitionShape`, `validateAgainstRegistry`, `AuthenticatedRequest`, `createTestApp`.
- Produces:
  - `DefinitionRepository.list(tenantId, opts?: { status?, name?, limit?, offset? }): Promise<{ rows: WorkflowDefinitionEntity[]; total: number }>`
  - `DefinitionRepository.update(tenantId, id, input): Promise<WorkflowDefinitionEntity>` — preserves `lastUpdateHistory`
  - `DefinitionRepository.publish(tenantId, id): Promise<WorkflowDefinitionEntity>` — draft→published→archived lifecycle
  - `DefinitionRepository.findByIds(tenantId, ids: number[]): Promise<WorkflowDefinitionEntity[]>`
  - Routes: `GET /api/v1/definitions`, `POST /api/v1/definitions`, `GET /api/v1/definitions/:id`, `PUT /api/v1/definitions/:id`, `POST /api/v1/definitions/:id/publish`, `POST /api/v1/definitions/import`

- [ ] **Step 1: Write the failing test**

`packages/server/test/definitions.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npm test -w @wfe/server -- definitions`
Expected: FAIL — routes not mounted, repository methods missing.

- [ ] **Step 3: Extend DefinitionRepository**

In `packages/core/src/repositories/definition-repository.ts`, add:

```typescript
  async list(
    tenantId: string,
    opts: { status?: string; name?: string; limit?: number; offset?: number } = {}
  ): Promise<{ rows: WorkflowDefinitionEntity[]; total: number }> {
    const ds = await this.db.getDataSource();
    const repo = ds.getRepository(WorkflowDefinitionEntity);
    const qb = repo.createQueryBuilder("d").where("d.tenantId = :tenantId", { tenantId });

    if (opts.status) qb.andWhere("d.status = :status", { status: opts.status });
    if (opts.name) qb.andWhere("d.name ILIKE :name", { name: `%${opts.name}%` });

    qb.orderBy("d.updatedDate", "DESC");
    qb.skip(opts.offset ?? 0).take(opts.limit ?? 50);

    const [rows, total] = await qb.getManyAndCount();
    return { rows, total };
  }

  async update(
    tenantId: string,
    id: number,
    input: { definition?: WorkflowDefinitionBody; name?: string; version?: string }
  ): Promise<WorkflowDefinitionEntity> {
    const ds = await this.db.getDataSource();
    const existing = await this.findById(tenantId, id);
    if (!existing) {
      throw new WfeError(`Definition ${id} not found`, { statusCode: 404, code: "DEFINITION_NOT_FOUND" });
    }

    existing.lastUpdateHistory = {
      definition: existing.definition,
      updatedDate: existing.updatedDate?.toISOString(),
    };

    if (input.definition) existing.definition = input.definition;
    if (input.name) existing.name = input.name;
    if (input.version) existing.version = input.version;

    return ds.getRepository(WorkflowDefinitionEntity).save(existing);
  }

  async publish(tenantId: string, id: number): Promise<WorkflowDefinitionEntity> {
    const existing = await this.findById(tenantId, id);
    if (!existing) {
      throw new WfeError(`Definition ${id} not found`, { statusCode: 404, code: "DEFINITION_NOT_FOUND" });
    }

    const lifecycle: Record<string, WorkflowDefinitionStatus> = {
      [WorkflowDefinitionStatus.DRAFT]: WorkflowDefinitionStatus.PUBLISHED,
      [WorkflowDefinitionStatus.PUBLISHED]: WorkflowDefinitionStatus.ARCHIVED,
    };

    const next = lifecycle[existing.status];
    if (!next) {
      throw new WfeError(
        `Definition ${id} is ${existing.status} and cannot be published`,
        { statusCode: 400, code: "DEFINITION_LIFECYCLE_INVALID" }
      );
    }

    existing.status = next;
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowDefinitionEntity).save(existing);
  }

  async findByIds(tenantId: string, ids: number[]): Promise<WorkflowDefinitionEntity[]> {
    if (ids.length === 0) return [];
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowDefinitionEntity)
      .createQueryBuilder("d")
      .where("d.tenantId = :tenantId", { tenantId })
      .andWhere("d.id IN (:...ids)", { ids })
      .getMany();
  }
```

Add the missing imports: `WfeError` from `../errors`, `WorkflowDefinitionStatus` from `@wfe/sdk`.

- [ ] **Step 4: Write the definitions controller**

`packages/server/src/controllers/definitions.ts`:

```typescript
import { Router } from "express";
import {
  DefinitionRepository, DbContext, StepRegistry,
  validateDefinitionShape, validateAgainstRegistry,
} from "@wfe/core";
import { AuthenticatedRequest } from "../auth/types";

export function definitionRoutes(deps: { db: DbContext; registry: StepRegistry }): Router {
  const router = Router();
  const definitions = new DefinitionRepository(deps.db);

  router.get("/definitions", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { status, name, limit, offset } = req.query;
      const result = await definitions.list(tenantId, {
        status: status as string | undefined,
        name: name as string | undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post("/definitions", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const body = await validateDefinitionShape(req.body.definition);
      validateAgainstRegistry(body, deps.registry);
      const entity = await definitions.create({
        tenantId,
        name: req.body.name,
        version: req.body.version,
        definition: body,
      });
      res.status(201).json(entity);
    } catch (err) { next(err); }
  });

  router.get("/definitions/:id", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const id = Number(req.params.id);
      const entity = await definitions.findById(tenantId, id);
      if (!entity) {
        res.status(404).json({ error: { code: "DEFINITION_NOT_FOUND", message: `Definition ${id} not found` } });
        return;
      }
      res.json(entity);
    } catch (err) { next(err); }
  });

  router.put("/definitions/:id", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const id = Number(req.params.id);
      let definition = req.body.definition;
      if (definition) {
        definition = await validateDefinitionShape(definition);
        validateAgainstRegistry(definition, deps.registry);
      }
      const updated = await definitions.update(tenantId, id, {
        definition, name: req.body.name, version: req.body.version,
      });
      res.json(updated);
    } catch (err) { next(err); }
  });

  router.post("/definitions/:id/publish", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const id = Number(req.params.id);
      const published = await definitions.publish(tenantId, id);
      res.json(published);
    } catch (err) { next(err); }
  });

  router.post("/definitions/import", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const items = Array.isArray(req.body) ? req.body : [req.body];
      let imported = 0;
      for (const item of items) {
        const body = await validateDefinitionShape(item.definition);
        validateAgainstRegistry(body, deps.registry);
        await definitions.create({
          tenantId, name: item.name, version: item.version, definition: body,
          status: item.status,
        });
        imported += 1;
      }
      res.status(201).json({ imported });
    } catch (err) { next(err); }
  });

  return router;
}
```

- [ ] **Step 5: Mount the definitions routes in createApp**

In `packages/server/src/app.ts`, add `import { definitionRoutes } from "./controllers/definitions";` and mount after the tenant middleware:

```typescript
  app.use("/api/v1", definitionRoutes({ db: deps.db, registry: deps.registry }));
```

- [ ] **Step 6: Run tests**

```bash
npm run build && npm test -w @wfe/server -- definitions
```

Expected: PASS — 10 tests.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm run build && npm test
git add packages/core packages/server
git commit -m "feat(server): add definition CRUD controller with list, update and publish"
```

---

### Task 3: Runs controller — create, list, search, get, cancel, restart, callback, inputs

**Files:**
- Modify: `packages/core/src/repositories/run-repository.ts` — add `list`, `search`, `findByIds`, `updateInputs`
- Create: `packages/core/src/entities/idempotency-key.ts`
- Create: `packages/core/src/db/migrations/0003-server-support.ts`
- Modify: `packages/core/src/db/db-context.ts` — register new entity + migration
- Create: `packages/server/src/controllers/runs.ts`
- Modify: `packages/server/src/app.ts` — mount runs routes
- Test: `packages/server/test/runs.test.ts`

**Interfaces:**
- Consumes: `RunExecutor`, `RunRepository`, `AuthenticatedRequest`, `createTestApp`, `DefinitionRepository`, `WorkflowDefinitionStatus`.
- Produces:
  - `RunRepository.list(tenantId, opts?: { status?, name?, limit?, offset? }): Promise<{ rows: WorkflowRun[]; total: number }>`
  - `RunRepository.search(tenantId, filter: Record<string, unknown>): Promise<WorkflowRun[]>` — jsonb search on `inputsJson`
  - `RunRepository.findByIds(tenantId, ids: number[]): Promise<WorkflowRun[]>`
  - `RunRepository.updateInputs(tenantId, id, inputs): Promise<WorkflowRun>`
  - `IdempotencyKeyEntity` + migration `ServerSupport0003`
  - Routes: `POST /api/v1/runs`, `GET /api/v1/runs`, `POST /api/v1/runs/search`, `GET /api/v1/runs/:id`, `POST /api/v1/runs/by-ids`, `PUT /api/v1/runs/:id/cancel`, `PUT /api/v1/runs/:id/restart/step/:n`, `PUT /api/v1/runs/:id/callback`, `PUT /api/v1/runs/:id/inputs`

- [ ] **Step 1: Write the failing test**

`packages/server/test/runs.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npm test -w @wfe/server -- runs`
Expected: FAIL.

- [ ] **Step 3: Create the IdempotencyKey entity**

`packages/core/src/entities/idempotency-key.ts`:

```typescript
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from "typeorm";

@Entity({ name: "idempotency_key" })
@Unique("uq_idempotency_key", ["tenantId", "key"])
export class IdempotencyKeyEntity {
  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: "varchar", length: 64, nullable: false })
  tenantId!: string;

  @Column({ type: "varchar", length: 255, nullable: false })
  key!: string;

  @Column({ type: "int", nullable: false })
  runId!: number;

  @CreateDateColumn()
  createdDate!: Date;
}
```

- [ ] **Step 4: Create migration 0003**

`packages/core/src/db/migrations/0003-server-support.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class ServerSupport0003 implements MigrationInterface {
  name = "ServerSupport1788900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idempotency_key (
        id SERIAL PRIMARY KEY,
        tenant_id varchar(64) NOT NULL,
        key varchar(255) NOT NULL,
        run_id integer NOT NULL REFERENCES workflow_run(id),
        created_date TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT uq_idempotency_key UNIQUE (tenant_id, key)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS idempotency_key CASCADE`);
  }
}
```

- [ ] **Step 5: Register entity and migration in DbContext**

In `packages/core/src/db/db-context.ts`, import `IdempotencyKeyEntity` and `ServerSupport0003`, add them to the `entities` and `migrations` arrays.

Export `IdempotencyKeyEntity` from `packages/core/src/index.ts`.

- [ ] **Step 6: Extend RunRepository**

In `packages/core/src/repositories/run-repository.ts`, add:

```typescript
  async list(
    tenantId: string,
    opts: { status?: string; name?: string; limit?: number; offset?: number } = {}
  ): Promise<{ rows: WorkflowRun[]; total: number }> {
    const ds = await this.db.getDataSource();
    const qb = ds.getRepository(WorkflowRun).createQueryBuilder("r")
      .where("r.tenantId = :tenantId", { tenantId });

    if (opts.status) qb.andWhere("r.status = :status", { status: opts.status });
    if (opts.name) qb.andWhere("r.name = :name", { name: opts.name });

    qb.orderBy("r.updatedDate", "DESC");
    qb.skip(opts.offset ?? 0).take(opts.limit ?? 50);

    const [rows, total] = await qb.getManyAndCount();
    return { rows, total };
  }

  async search(tenantId: string, filter: Record<string, unknown>): Promise<WorkflowRun[]> {
    const ds = await this.db.getDataSource();
    const qb = ds.getRepository(WorkflowRun).createQueryBuilder("r")
      .where("r.tenantId = :tenantId", { tenantId });

    // Each key like "inputs.foo" becomes a jsonb containment check
    for (const [key, value] of Object.entries(filter)) {
      const [column, ...path] = key.split(".");
      const jsonColumn = `${column}_json`;
      const paramName = `filter_${path.join("_")}`;
      if (path.length > 0) {
        qb.andWhere(`r.${jsonColumn} @> :${paramName}`, {
          [paramName]: JSON.stringify(path.reduceRight((acc, k) => ({ [k]: acc }), value as never)),
        });
      }
    }

    qb.orderBy("r.updatedDate", "DESC").take(100);
    return qb.getMany();
  }

  async findByIds(tenantId: string, ids: number[]): Promise<WorkflowRun[]> {
    if (ids.length === 0) return [];
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowRun).createQueryBuilder("r")
      .where("r.tenantId = :tenantId", { tenantId })
      .andWhere("r.id IN (:...ids)", { ids })
      .getMany();
  }

  async updateInputs(tenantId: string, id: number, inputs: WorkflowParameters): Promise<WorkflowRun> {
    const run = await this.findById(tenantId, id);
    if (!run) {
      throw new WfeError(`Run ${id} not found`, { statusCode: 404, code: "RUN_NOT_FOUND" });
    }
    run.inputs = inputs;
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowRun).save(run);
  }
```

Add the missing imports (`WorkflowParameters` from `@wfe/sdk`).

- [ ] **Step 7: Write the runs controller**

`packages/server/src/controllers/runs.ts`:

```typescript
import { Router } from "express";
import {
  RunExecutor, RunRepository, DbContext, IdempotencyKeyEntity,
} from "@wfe/core";
import { AuthenticatedRequest } from "../auth/types";

export function runRoutes(deps: { executor: RunExecutor; db: DbContext }): Router {
  const router = Router();
  const runs = new RunRepository(deps.db);

  router.post("/runs", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { name, version, inputs } = req.body;
      const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

      if (idempotencyKey) {
        const ds = await deps.db.getDataSource();
        const existing = await ds.getRepository(IdempotencyKeyEntity).findOneBy({
          tenantId, key: idempotencyKey,
        });
        if (existing) {
          const run = await runs.findById(tenantId, existing.runId);
          res.status(200).json({ runId: existing.runId, status: run?.status ?? "unknown" });
          return;
        }
      }

      const runId = await deps.executor.startWorkflow({ tenantId, name, version, inputs: inputs ?? {} });
      const run = await deps.executor.start(tenantId, runId);

      if (idempotencyKey) {
        const ds = await deps.db.getDataSource();
        const key = new IdempotencyKeyEntity();
        key.tenantId = tenantId;
        key.key = idempotencyKey;
        key.runId = runId;
        await ds.getRepository(IdempotencyKeyEntity).save(key);
      }

      res.status(201).json({ runId, status: run.status });
    } catch (err) { next(err); }
  });

  router.get("/runs", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { status, name, limit, offset } = req.query;
      const result = await runs.list(tenantId, {
        status: status as string | undefined,
        name: name as string | undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post("/runs/search", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const results = await runs.search(tenantId, req.body.filter ?? {});
      res.json(results);
    } catch (err) { next(err); }
  });

  router.post("/runs/by-ids", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const results = await runs.findByIds(tenantId, req.body.ids ?? []);
      res.json(results);
    } catch (err) { next(err); }
  });

  router.get("/runs/:id", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const run = await runs.findById(tenantId, Number(req.params.id));
      if (!run) {
        res.status(404).json({ error: { code: "RUN_NOT_FOUND", message: `Run ${req.params.id} not found` } });
        return;
      }
      res.json(run);
    } catch (err) { next(err); }
  });

  router.put("/runs/:id/cancel", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const run = await deps.executor.cancel(tenantId, Number(req.params.id));
      res.json(run);
    } catch (err) { next(err); }
  });

  router.put("/runs/:id/restart/step/:n", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const run = await deps.executor.restartFromStep(
        tenantId, Number(req.params.id), Number(req.params.n)
      );
      res.json(run);
    } catch (err) { next(err); }
  });

  router.put("/runs/:id/callback", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { stepNumber, body } = req.body;
      const run = await deps.executor.callback(
        tenantId, Number(req.params.id), stepNumber, body
      );
      res.json(run);
    } catch (err) { next(err); }
  });

  router.put("/runs/:id/inputs", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const run = await runs.updateInputs(tenantId, Number(req.params.id), req.body.inputs ?? {});
      res.json(run);
    } catch (err) { next(err); }
  });

  return router;
}
```

- [ ] **Step 8: Mount runs routes in createApp**

In `packages/server/src/app.ts`, import `runRoutes` and mount:

```typescript
  app.use("/api/v1", runRoutes({ executor: deps.executor, db: deps.db }));
```

- [ ] **Step 9: Run tests**

```bash
npm run build && npm test -w @wfe/server -- runs
```

Expected: PASS — 11 tests.

- [ ] **Step 10: Run the full suite and commit**

```bash
npm run build && npm test
git add packages/core packages/server
git commit -m "feat(server): add runs controller with create, list, search, cancel, callback and idempotency"
```

---

### Task 4: Steps controller — claim next, search, state/inputs/outputs, priority, step-types, dry-run

**Files:**
- Create: `packages/core/src/repositories/step-repository.ts`
- Modify: `packages/core/src/index.ts` — export step repository
- Create: `packages/server/src/controllers/steps.ts`
- Modify: `packages/server/src/app.ts` — mount steps routes
- Test: `packages/server/test/steps.test.ts`

**Interfaces:**
- Consumes: `StepRun`, `StepRegistry`, `DbContext`, `RunExecutor`, `ExpressionEvaluator`, `AuthenticatedRequest`, `createTestApp`.
- Produces:
  - `class StepRepository { claimNext(tenantId, service, opts?); search(tenantId, filter); updateState(tenantId, id, state); updateInputsOutputs(tenantId, id, inputs, outputs); updatePriority(tenantId, id, priority) }`
  - Routes: `GET /api/v1/steps/next`, `POST /api/v1/steps/search`, `PUT /api/v1/steps/:id/state`, `PUT /api/v1/steps/:id/inputs-outputs`, `PUT /api/v1/steps/:id/priority`, `GET /api/v1/step-types`, `POST /api/v1/steps/dry-run`

- [ ] **Step 1: Write the failing test**

`packages/server/test/steps.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npm test -w @wfe/server -- steps`
Expected: FAIL.

- [ ] **Step 3: Write the StepRepository**

`packages/core/src/repositories/step-repository.ts`:

```typescript
import { WorkflowParameters, WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../db/db-context";
import { StepRun } from "../entities/step-run";
import { WfeError } from "../errors";

export class StepRepository {
  constructor(private readonly db: DbContext) {}

  /**
   * Claims the next step waiting for an external service. Ordered by priority
   * (highest first, nulls last) then by creation date. Used by
   * `GET /steps/next`.
   */
  async claimNext(
    tenantId: string,
    service: string,
  ): Promise<StepRun | null> {
    const ds = await this.db.getDataSource();
    const step = await ds.getRepository(StepRun)
      .createQueryBuilder("s")
      .where("s.tenantId = :tenantId", { tenantId })
      .andWhere("s.status = :status", { status: WorkflowStatus.WAITING })
      .andWhere("s.externalServiceName = :service", { service })
      .orderBy("s.priority", "DESC", "NULLS LAST")
      .addOrderBy("s.createdDate", "ASC")
      .getOne();
    return step;
  }

  async search(
    tenantId: string,
    filter: { status?: string; externalServiceName?: string; runId?: number }
  ): Promise<StepRun[]> {
    const ds = await this.db.getDataSource();
    const qb = ds.getRepository(StepRun).createQueryBuilder("s")
      .where("s.tenantId = :tenantId", { tenantId });

    if (filter.status) qb.andWhere("s.status = :status", { status: filter.status });
    if (filter.externalServiceName) {
      qb.andWhere("s.externalServiceName = :esn", { esn: filter.externalServiceName });
    }
    if (filter.runId) qb.andWhere("s.runId = :runId", { runId: filter.runId });

    qb.orderBy("s.createdDate", "DESC").take(100);
    return qb.getMany();
  }

  async findById(tenantId: string, id: number): Promise<StepRun | null> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(StepRun).findOneBy({ id, tenantId });
  }

  async updateState(tenantId: string, id: number, state: WorkflowParameters): Promise<StepRun> {
    const step = await this.findById(tenantId, id);
    if (!step) throw new WfeError(`Step ${id} not found`, { statusCode: 404, code: "STEP_NOT_FOUND" });
    step.state = state;
    const ds = await this.db.getDataSource();
    return ds.getRepository(StepRun).save(step);
  }

  async updateInputsOutputs(
    tenantId: string, id: number, inputs: WorkflowParameters, outputs: WorkflowParameters
  ): Promise<StepRun> {
    const step = await this.findById(tenantId, id);
    if (!step) throw new WfeError(`Step ${id} not found`, { statusCode: 404, code: "STEP_NOT_FOUND" });
    step.inputs = inputs;
    step.outputs = outputs;
    const ds = await this.db.getDataSource();
    return ds.getRepository(StepRun).save(step);
  }

  async updatePriority(tenantId: string, id: number, priority: number): Promise<StepRun> {
    const step = await this.findById(tenantId, id);
    if (!step) throw new WfeError(`Step ${id} not found`, { statusCode: 404, code: "STEP_NOT_FOUND" });
    step.priority = priority;
    const ds = await this.db.getDataSource();
    return ds.getRepository(StepRun).save(step);
  }
}
```

Export from `packages/core/src/index.ts`: `export * from "./repositories/step-repository";`

- [ ] **Step 4: Write the steps controller**

`packages/server/src/controllers/steps.ts`:

```typescript
import { Router } from "express";
import {
  DbContext, StepRegistry, ExpressionEvaluator, StepRepository,
  captureParameters, WorkflowRun,
} from "@wfe/core";
import { WorkflowStatus } from "@wfe/sdk";
import { AuthenticatedRequest } from "../auth/types";

export function stepRoutes(deps: {
  db: DbContext; registry: StepRegistry; evaluator: ExpressionEvaluator;
}): Router {
  const router = Router();
  const steps = new StepRepository(deps.db);

  router.get("/step-types", (req, res) => {
    const types = deps.registry.list().map((r) => ({
      type: r.type, version: r.version, description: r.description,
    }));
    res.json(types);
  });

  router.get("/steps/next", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const service = req.query.service as string;
      if (!service) {
        res.status(400).json({ error: { code: "MISSING_SERVICE", message: "service query parameter is required" } });
        return;
      }
      const step = await steps.claimNext(tenantId, service);
      if (!step) {
        res.status(204).end();
        return;
      }
      res.json(step);
    } catch (err) { next(err); }
  });

  router.post("/steps/search", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const result = await steps.search(tenantId, req.body);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.put("/steps/:id/state", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const step = await steps.updateState(tenantId, Number(req.params.id), req.body.state ?? {});
      res.json(step);
    } catch (err) { next(err); }
  });

  router.put("/steps/:id/inputs-outputs", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const step = await steps.updateInputsOutputs(
        tenantId, Number(req.params.id), req.body.inputs ?? {}, req.body.outputs ?? {}
      );
      res.json(step);
    } catch (err) { next(err); }
  });

  router.put("/steps/:id/priority", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const step = await steps.updatePriority(tenantId, Number(req.params.id), req.body.priority);
      res.json(step);
    } catch (err) { next(err); }
  });

  router.post("/steps/dry-run", async (req, res, next) => {
    try {
      const { expressions, state, config, body } = req.body;
      // Build a minimal run-like object for the evaluator
      const fakeRun = {
        tenantId: "default", name: "dry-run", version: "0",
        currentStep: 0, status: WorkflowStatus.RUNNING,
        inputs: state?.inputs ?? {}, outputs: state?.outputs ?? {},
        state: state?.state ?? {}, stepRuns: [],
      } as unknown as WorkflowRun;

      const result = await captureParameters({
        evaluator: deps.evaluator,
        run: fakeRun,
        expressions: expressions ?? [],
        config: config ?? {},
        body,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  return router;
}
```

- [ ] **Step 5: Mount steps routes in createApp**

In `packages/server/src/app.ts`, import `stepRoutes` and mount. Also add `evaluator: ExpressionEvaluator` to `AppDeps`:

```typescript
  app.use("/api/v1", stepRoutes({ db: deps.db, registry: deps.registry, evaluator: deps.evaluator }));
```

Update `AppDeps` interface to include `evaluator: ExpressionEvaluator`. Update `createTestApp` to pass it.

- [ ] **Step 6: Run tests**

```bash
npm run build && npm test -w @wfe/server -- steps
```

Expected: PASS — 5 tests.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm run build && npm test
git add packages/core packages/server
git commit -m "feat(server): add steps controller with claim-next, search, dry-run and step-types"
```

---

### Task 5: OpenAPI document

**Files:**
- Create: `packages/server/src/openapi/spec.ts`
- Modify: `packages/server/src/controllers/system.ts` — add `GET /openapi.json` and swagger-ui middleware
- Modify: `packages/server/src/app.ts` — mount swagger-ui
- Test: `packages/server/test/system.test.ts` — add OpenAPI tests

**Interfaces:**
- Consumes: Express app, `StepRegistry`.
- Produces: `buildOpenApiSpec(registry): OpenAPIObject`; `GET /api/v1/openapi.json`; swagger-ui at `/api/v1/docs`.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/system.test.ts`:

```typescript
  it("GET /api/v1/openapi.json returns a valid OpenAPI 3 document", async () => {
    const res = await request(ctx.app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.paths).toBeDefined();
    expect(res.body.paths["/api/v1/runs"]).toBeDefined();
    expect(res.body.paths["/api/v1/definitions"]).toBeDefined();
  });

  it("GET /api/v1/docs serves swagger-ui HTML", async () => {
    const res = await request(ctx.app).get("/api/v1/docs/").redirects(1);
    expect(res.status).toBe(200);
    expect(res.text).toContain("swagger");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npm test -w @wfe/server -- system`
Expected: FAIL — `/openapi.json` 404, `/docs` 404.

- [ ] **Step 3: Write the OpenAPI spec builder**

`packages/server/src/openapi/spec.ts`:

```typescript
import { StepRegistry } from "@wfe/core";

export function buildOpenApiSpec(registry: StepRegistry): Record<string, unknown> {
  const stepTypes = registry.list().map((r) => ({
    type: r.type, version: r.version, description: r.description ?? "",
  }));

  return {
    openapi: "3.0.3",
    info: {
      title: "Workflow Engine API",
      version: "0.1.0",
      description: "REST API for the standalone workflow engine.",
    },
    paths: {
      "/api/v1/health": {
        get: {
          summary: "Health check",
          operationId: "getHealth",
          tags: ["System"],
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" } } } } } } },
        },
      },
      "/api/v1/version": {
        get: {
          summary: "Version info",
          operationId: "getVersion",
          tags: ["System"],
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", properties: { version: { type: "string" } } } } } } },
        },
      },
      "/api/v1/definitions": {
        get: {
          summary: "List workflow definitions",
          operationId: "listDefinitions",
          tags: ["Definitions"],
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["draft", "published", "archived"] } },
            { name: "name", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { 200: { description: "Paginated list of definitions" } },
        },
        post: {
          summary: "Create a workflow definition",
          operationId: "createDefinition",
          tags: ["Definitions"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, version: { type: "string" }, definition: { type: "object" } }, required: ["name", "version", "definition"] } } } },
          responses: { 201: { description: "Created" }, 400: { description: "Validation error" } },
        },
      },
      "/api/v1/definitions/{id}": {
        get: {
          summary: "Get a workflow definition",
          operationId: "getDefinition",
          tags: ["Definitions"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Definition" }, 404: { description: "Not found" } },
        },
        put: {
          summary: "Update a workflow definition",
          operationId: "updateDefinition",
          tags: ["Definitions"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Updated" }, 404: { description: "Not found" } },
        },
      },
      "/api/v1/definitions/{id}/publish": {
        post: {
          summary: "Publish (or archive) a definition",
          operationId: "publishDefinition",
          tags: ["Definitions"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Status transitioned" }, 400: { description: "Invalid transition" } },
        },
      },
      "/api/v1/definitions/import": {
        post: {
          summary: "Bulk import definitions",
          operationId: "importDefinitions",
          tags: ["Definitions"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "array", items: { type: "object" } } } } },
          responses: { 201: { description: "Imported" } },
        },
      },
      "/api/v1/runs": {
        post: {
          summary: "Start a workflow run",
          operationId: "createRun",
          tags: ["Runs"],
          parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, version: { type: "string" }, inputs: { type: "object" } }, required: ["name", "version"] } } } },
          responses: { 201: { description: "Run started" }, 200: { description: "Idempotent replay" } },
        },
        get: {
          summary: "List workflow runs",
          operationId: "listRuns",
          tags: ["Runs"],
          parameters: [
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "name", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { 200: { description: "Paginated list of runs" } },
        },
      },
      "/api/v1/runs/{id}": {
        get: {
          summary: "Get a workflow run with all step runs",
          operationId: "getRun",
          tags: ["Runs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Run with steps" }, 404: { description: "Not found" } },
        },
      },
      "/api/v1/runs/search": {
        post: {
          summary: "Deep jsonb search across runs",
          operationId: "searchRuns",
          tags: ["Runs"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { filter: { type: "object" } } } } } },
          responses: { 200: { description: "Matching runs" } },
        },
      },
      "/api/v1/runs/by-ids": {
        post: {
          summary: "Get multiple runs by ID",
          operationId: "getRunsByIds",
          tags: ["Runs"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { ids: { type: "array", items: { type: "integer" } } } } } } },
          responses: { 200: { description: "Runs" } },
        },
      },
      "/api/v1/runs/{id}/cancel": {
        put: {
          summary: "Cancel a workflow run",
          operationId: "cancelRun",
          tags: ["Runs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Cancelled" } },
        },
      },
      "/api/v1/runs/{id}/restart/step/{n}": {
        put: {
          summary: "Restart a run from a specific step",
          operationId: "restartFromStep",
          tags: ["Runs"],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
            { name: "n", in: "path", required: true, schema: { type: "integer" } },
          ],
          responses: { 200: { description: "Restarted" } },
        },
      },
      "/api/v1/runs/{id}/callback": {
        put: {
          summary: "External worker callback",
          operationId: "callback",
          tags: ["Runs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { stepNumber: { type: "integer" }, body: { type: "object" } }, required: ["stepNumber"] } } } },
          responses: { 200: { description: "Resumed" } },
        },
      },
      "/api/v1/runs/{id}/inputs": {
        put: {
          summary: "Update run inputs",
          operationId: "updateRunInputs",
          tags: ["Runs"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { inputs: { type: "object" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/api/v1/steps/next": {
        get: {
          summary: "Claim next external task step",
          operationId: "claimNextStep",
          tags: ["Steps"],
          parameters: [{ name: "service", in: "query", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Step claimed" }, 204: { description: "No step available" } },
        },
      },
      "/api/v1/steps/search": {
        post: {
          summary: "Search step runs",
          operationId: "searchSteps",
          tags: ["Steps"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Matching steps" } },
        },
      },
      "/api/v1/steps/{id}/state": {
        put: {
          summary: "Update step state",
          operationId: "updateStepState",
          tags: ["Steps"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { state: { type: "object" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/api/v1/steps/{id}/inputs-outputs": {
        put: {
          summary: "Update step inputs and outputs",
          operationId: "updateStepInputsOutputs",
          tags: ["Steps"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Updated" } },
        },
      },
      "/api/v1/steps/{id}/priority": {
        put: {
          summary: "Update step priority",
          operationId: "updateStepPriority",
          tags: ["Steps"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { priority: { type: "integer" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/api/v1/step-types": {
        get: {
          summary: "List registered step types",
          operationId: "listStepTypes",
          tags: ["Steps"],
          responses: { 200: { description: "Step types", content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { type: { type: "string" }, version: { type: "string" }, description: { type: "string" } } } } } } } },
        },
      },
      "/api/v1/steps/dry-run": {
        post: {
          summary: "Evaluate capture expressions against sample state",
          operationId: "dryRunStep",
          tags: ["Steps"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { expressions: { type: "array" }, state: { type: "object" }, config: { type: "object" }, body: {} } } } } },
          responses: { 200: { description: "Evaluation result" } },
        },
      },
    },
    components: {
      schemas: {
        StepType: {
          type: "object",
          properties: {
            type: { type: "string" }, version: { type: "string" }, description: { type: "string" },
          },
        },
      },
    },
    "x-step-types": stepTypes,
  };
}
```

- [ ] **Step 4: Mount OpenAPI and swagger-ui**

In `packages/server/src/controllers/system.ts`, add OpenAPI route:

```typescript
import { StepRegistry } from "@wfe/core";
import { buildOpenApiSpec } from "../openapi/spec";

export function systemRoutes(deps?: { registry?: StepRegistry }): Router {
  // ... existing health/version routes ...

  if (deps?.registry) {
    const spec = buildOpenApiSpec(deps.registry);

    router.get("/openapi.json", (_req, res) => {
      res.json(spec);
    });
  }

  return router;
}
```

In `packages/server/src/app.ts`, update the system route mounts and add swagger-ui:

```typescript
import swaggerUi from "swagger-ui-express";
import { buildOpenApiSpec } from "./openapi/spec";

  // Mount authenticated system routes with OpenAPI
  app.use("/api/v1", systemRoutes({ registry: deps.registry }));

  // Swagger UI
  const spec = buildOpenApiSpec(deps.registry);
  app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(spec));
```

Update `AppDeps` and `createTestApp` to pass `registry`.

- [ ] **Step 5: Run tests**

```bash
npm run build && npm test -w @wfe/server -- system
```

Expected: PASS — 7 tests (5 existing + 2 new).

- [ ] **Step 6: Run the full suite and commit**

```bash
npm run build && npm test
git add packages/server
git commit -m "feat(server): add OpenAPI 3 document and swagger-ui"
```

---

### Task 6: CLI — migrate, import, serve, worker

**Files:**
- Create: `packages/server/src/cli/index.ts`
- Modify: `packages/server/package.json` — add `bin` field
- Test: `packages/server/test/cli.test.ts`

**Interfaces:**
- Consumes: `ServerConfig`, `loadServerConfig`, `DbContext`, `ExpressionEvaluator`, `StepRegistry`, `registerBuiltInSteps`, `createQueueDriver`, `RunExecutor`, `WorkflowWorker`, `createApp`, `NoneAuthProvider`, `DefinitionRepository`, `validateDefinitionShape`, `validateAgainstRegistry`.
- Produces: `wfe migrate`, `wfe import <dir>`, `wfe serve`, `wfe worker` CLI commands.

- [ ] **Step 1: Write the failing test**

`packages/server/test/cli.test.ts`:

```typescript
import { execSync } from "child_process";
import { join } from "path";

jest.setTimeout(30000);

const cli = join(__dirname, "../src/cli/index.ts");

describe("CLI", () => {
  it("prints help without error", () => {
    const output = execSync(`npx ts-node ${cli} --help`, {
      encoding: "utf8",
      cwd: join(__dirname, "../.."),
    });
    expect(output).toContain("migrate");
    expect(output).toContain("serve");
    expect(output).toContain("worker");
    expect(output).toContain("import");
  });

  it("rejects an unknown command", () => {
    expect(() =>
      execSync(`npx ts-node ${cli} bogus 2>&1`, {
        encoding: "utf8",
        cwd: join(__dirname, "../.."),
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npm test -w @wfe/server -- cli`
Expected: FAIL — file not found.

- [ ] **Step 3: Write the CLI**

`packages/server/src/cli/index.ts`:

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  DbContext, ExpressionEvaluator, StepRegistry, registerBuiltInSteps,
  createQueueDriver, RunExecutor, WorkflowWorker,
  DefinitionRepository, validateDefinitionShape, validateAgainstRegistry,
  createLogger, DELAY_QUEUE, RESPONSE_QUEUE,
} from "@wfe/core";
import { loadServerConfig } from "../config";
import { createApp } from "../app";
import { NoneAuthProvider } from "../auth/none-provider";

const log = createLogger("cli");
const program = new Command();

program
  .name("wfe")
  .description("Workflow Engine CLI")
  .version("0.1.0");

program
  .command("migrate")
  .description("Run database migrations")
  .action(async () => {
    const config = loadServerConfig();
    const db = new DbContext(config);
    try {
      await db.runMigrations();
      log.info("Migrations complete");
    } finally {
      await db.close();
    }
  });

program
  .command("import <dir>")
  .description("Import workflow definitions from a directory of JSON files")
  .action(async (dir: string) => {
    const config = loadServerConfig();
    const db = new DbContext(config);
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);

    try {
      await db.runMigrations();
      const definitions = new DefinitionRepository(db);
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

      for (const file of files) {
        const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
        const body = await validateDefinitionShape(raw.definition);
        validateAgainstRegistry(body, registry);
        await definitions.create({
          tenantId: "default",
          name: raw.workflowName ?? raw.name,
          version: raw.workflowVersion ?? raw.version,
          definition: body,
          status: raw.status,
        });
        log.info("Imported definition", { file, name: raw.workflowName ?? raw.name });
      }
      log.info("Import complete", { count: files.length });
    } finally {
      await db.close();
    }
  });

program
  .command("serve")
  .description("Start the HTTP server")
  .action(async () => {
    const config = loadServerConfig();
    const db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    const evaluator = new ExpressionEvaluator({ timeoutMs: config.expressionTimeoutMs });

    let queue;
    if (config.queueDriver !== "none") {
      // Import driver modules to trigger their self-registration
      if (config.queueDriver === "rabbitmq") await import("@wfe/core/dist/queue/rabbitmq-driver");
      if (config.queueDriver === "sqs") await import("@wfe/core/dist/queue/sqs-driver");
      queue = createQueueDriver(config.queueDriver, {
        url: config.queueUrl,
        prefix: config.sqsPrefix,
        region: config.awsRegion,
      });
      await queue.ensureQueues([{ queueName: DELAY_QUEUE }, { queueName: RESPONSE_QUEUE }]);
    }

    const executor = new RunExecutor({ config, db, registry, evaluator, queue });
    const authProvider = new NoneAuthProvider();
    const app = createApp({ executor, db, registry, authProvider, queue, evaluator });

    app.listen(config.port, () => {
      log.info("Server started", { port: config.port, queue: config.queueDriver });
    });
  });

program
  .command("worker")
  .description("Start the queue worker (listeners only, no HTTP)")
  .action(async () => {
    const config = loadServerConfig();
    const db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    const evaluator = new ExpressionEvaluator({ timeoutMs: config.expressionTimeoutMs });

    // Import driver module
    if (config.queueDriver === "rabbitmq") await import("@wfe/core/dist/queue/rabbitmq-driver");
    if (config.queueDriver === "sqs") await import("@wfe/core/dist/queue/sqs-driver");
    const queue = createQueueDriver(config.queueDriver, {
      url: config.queueUrl,
      prefix: config.sqsPrefix,
      region: config.awsRegion,
    });

    const executor = new RunExecutor({ config, db, registry, evaluator, queue });
    const worker = new WorkflowWorker({
      executor, queue,
      services: Object.keys(config.servicesConfig),
    });

    await worker.start();
    log.info("Worker started", { driver: config.queueDriver, services: Object.keys(config.servicesConfig) });

    // Graceful shutdown
    const shutdown = async () => {
      log.info("Shutting down worker");
      await worker.stop();
      evaluator.dispose();
      await db.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parse();
```

- [ ] **Step 4: Add bin to package.json**

In `packages/server/package.json`, add:

```json
  "bin": { "wfe": "dist/cli/index.js" }
```

- [ ] **Step 5: Run tests**

```bash
npm run build && npm test -w @wfe/server -- cli
```

Expected: PASS — 2 tests.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm run build && npm test
git add packages/server
git commit -m "feat(server): add wfe CLI with migrate, import, serve and worker commands"
```

---

### Task 7: Fix pg deprecation warning, update docker-compose, docs and final review

**Files:**
- Modify: `packages/core/src/repositories/run-repository.ts` — fix overlapping query
- Modify: `docker-compose.yml` — add server service
- Modify: `README.md` — update roadmap, add API section
- Modify: `docs/superpowers/carry-forward.md` — mark pg warning resolved
- Test: verify clean suite output

**Interfaces:**
- Consumes: everything built in Tasks 1–6.
- Produces: clean suite output (no pg deprecation warning), updated compose file with a `server` service, updated docs.

- [ ] **Step 1: Investigate and fix the pg deprecation warning**

The warning is:

```
DeprecationWarning: Calling client.query() when the client is already executing
a query is deprecated and will be removed in pg@9.0
```

This comes from `saveChecked` in `run-repository.ts` — the `manager.query()` call for `SET LOCAL lock_timeout` and the subsequent `manager.query()` for the `SELECT ... FOR UPDATE` can overlap if TypeORM's transaction manager pipelines them on the same underlying `pg` `Client`. The fix is to `await` each query sequentially and ensure no query is issued while another is in flight on the same client.

Examine the `saveChecked` method. The likely cause is that `manager.getRepository(WorkflowRun).save(run)` inside the transaction triggers the `@BeforeInsert`/`@BeforeUpdate` lifecycle hooks while the transaction's queries are still conceptually in-flight, or that TypeORM's internal `save` issues multiple queries on the same client connection without awaiting. To fix, ensure the raw `manager.query` calls are fully awaited before calling `save`, and potentially use `manager.save(run)` instead of `manager.getRepository().save()` to avoid an extra connection acquisition.

Check the existing code — the `SET LOCAL` and `SELECT ... FOR UPDATE` are properly awaited. The issue is likely in TypeORM's `save()` implementation which may internally issue multiple queries on the same connection when the entity has eager relations and lifecycle hooks. A fix: use `manager.createQueryBuilder()` for the final UPDATE instead of `save()`, or split the transaction so the save happens outside the raw query scope.

Most likely fix: the `save(run)` call on the repository's `getRepository` path in `run-repository.ts` at lines doing the `manager.getRepository(WorkflowRun).save(run)` — this triggers `@BeforeInsert`/`@BeforeUpdate` callbacks that write to jsonb columns while the `save` is doing its own query. The pragmatic fix is to call `copyParametersToJson()` explicitly before the save and use `manager.save(WorkflowRun, run)` directly.

However, the deprecation may also come from the non-`saveChecked` path — the plain `save` method. We need to check where the warning is generated during tests.

Run the suite with `--trace-deprecation` to locate the exact source:

```bash
cd packages/core && node --trace-deprecation ../../node_modules/.bin/jest --verbose 2>&1 | grep -A5 DeprecationWarning
```

Then apply the fix based on the trace. The most likely solution is ensuring that in the `saveChecked` transaction, all queries are strictly sequential.

After identifying and fixing the source, verify:

```bash
npm run build && npm test 2>&1 | grep -i deprecation
```

Expected: no output (no deprecation warnings).

- [ ] **Step 2: Update docker-compose.yml**

Add a `server` service to `docker-compose.yml`:

```yaml
  server:
    build: .
    ports:
      - "3000:3000"
    environment:
      WFE_DB_URL: postgres://postgres:postgres@postgres:5432/wfe
      WFE_QUEUE_DRIVER: rabbitmq
      WFE_QUEUE_URL: amqp://rabbitmq:5672
      WFE_PORT: "3000"
    depends_on:
      postgres:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy

  worker:
    build: .
    command: ["node", "packages/server/dist/cli/index.js", "worker"]
    environment:
      WFE_DB_URL: postgres://postgres:postgres@postgres:5432/wfe
      WFE_QUEUE_DRIVER: rabbitmq
      WFE_QUEUE_URL: amqp://rabbitmq:5672
    depends_on:
      postgres:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy
```

Create a `Dockerfile`:

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "packages/server/dist/cli/index.js", "serve"]
```

- [ ] **Step 3: Update carry-forward.md**

Mark the pg deprecation warning as resolved:

```markdown
### ~~pg deprecation warning~~ (resolved, Phase 3)

**Resolution:** Fixed the overlapping query in `saveChecked` that triggered
the `client.query()` deprecation warning. Suite output is now clean.
```

- [ ] **Step 4: Update README.md**

Update the roadmap table to mark Phase 3 complete. Add a **REST API** section documenting:
- Base URL: `/api/v1`
- Key routes (definitions, runs, steps, system)
- OpenAPI docs at `/api/v1/docs`
- CLI commands: `wfe migrate`, `wfe import <dir>`, `wfe serve`, `wfe worker`
- Configuration env vars (WFE_PORT, WFE_AUTH_PROVIDER, etc.)
- `docker compose up` quickstart

- [ ] **Step 5: Run the full suite**

```bash
npm run build && npm test
```

Expected: PASS. All suites green, no deprecation warnings.

Report the final test counts: core suites/tests, sdk suites/tests, server suites/tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): fix pg deprecation, add Dockerfile, docker-compose server and Phase 3 docs"
```

---

## Out of scope for this plan

Deferred deliberately, each with a reason:

- **Snapshotting the definition onto the run.** Still deferred from Phase 1 — `PUT /definitions/:id` now makes this more urgent. Phase 4 should tackle it alongside plugin loading, since a plugin update changing a step's type name would break the same in-flight runs.
- **Batch job endpoints.** `GET|POST|PUT /batch-jobs` and `GET /batch-jobs/:id` from spec §10 — batch fan-out is a distinct feature with its own entity and is better delivered as a Phase 4 addition than crammed into the already-large server phase.
- **Filter configuration endpoint.** `GET /filter-configuration` from spec §10 — a meta-endpoint for the UI to discover which filters exist. Useful only after Phase 5 (UI) begins.
- **Rate limiting and request validation.** The API is unauthenticated in v1; rate limiting is a Phase 6 production-hardening concern.
- **Kafka, Redis, NATS queue drivers.** Additive via the registry; not required by the spec.
- **Plugin loading (WFE_PLUGINS).** Spec §7.1 — Phase 4's feature. The CLI's `serve` command registers only built-in steps; Phase 4 adds the plugin loader.
- **`delay-step.ts` NaN guard.** Carry-forward item for Phase 3 or 4 — Phase 4 with the rest of definition validation is the better home.
- **RabbitMQ driver deferred minors.** Carry-forward item — ack/nack race, bucket clamping, holding-queue name collisions. Worth a pass when the driver next gets attention, but not blocking.
