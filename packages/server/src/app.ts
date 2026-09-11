import { join } from "node:path";
import express, { Express } from "express";
import swaggerUi from "swagger-ui-express";
import { RunExecutor, StepRegistry, DbContext, QueueDriver, ExpressionEvaluator, EngineConfig } from "@wfe/core";
import { AuthProvider } from "./auth/types";
import { errorHandler } from "./middleware/error-handler";
import { tenantMiddleware } from "./middleware/tenant";
import { requestIdMiddleware } from "./middleware/request-id";
import { systemRoutes } from "./controllers/system";
import { definitionRoutes } from "./controllers/definitions";
import { runRoutes } from "./controllers/runs";
import { stepRoutes } from "./controllers/steps";
import { batchJobRoutes } from "./controllers/batch-jobs";
import { buildOpenApiSpec } from "./openapi/spec";

export interface AppDeps {
  executor: RunExecutor;
  db: DbContext;
  registry: StepRegistry;
  authProvider: AuthProvider;
  evaluator: ExpressionEvaluator;
  queue?: QueueDriver;
  /** Passed through to routes that read engine-level config, e.g. batch-jobs' `maxBatchInputs`. */
  config?: EngineConfig;
  /**
   * Absolute path to the built UI (packages/ui/dist). When set, the app serves
   * it at the root with an SPA fallback. Optional so the server runs headless
   * and so tests need no Vite build.
   */
  uiRoot?: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.use(express.json({ limit: "10mb" }));
  app.use(requestIdMiddleware());

  // Health and version are unauthenticated and unlogged
  app.use(systemRoutes());
  app.use("/api/v1", systemRoutes({ registry: deps.registry }));

  const spec = buildOpenApiSpec(deps.registry);
  app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(spec));

  // All /api/v1 routes below this point require tenant resolution
  app.use("/api/v1", tenantMiddleware(deps.authProvider));

  app.use("/api/v1", definitionRoutes({ db: deps.db, registry: deps.registry }));
  app.use("/api/v1", runRoutes({ executor: deps.executor, db: deps.db }));
  app.use("/api/v1", stepRoutes({ db: deps.db, registry: deps.registry, evaluator: deps.evaluator }));
  app.use("/api/v1", batchJobRoutes({ executor: deps.executor, db: deps.db, config: deps.config }));

  if (deps.uiRoot) {
    app.use(express.static(deps.uiRoot));
    // SPA fallback: a refresh on /runs/42 must reach the client router. Guarded
    // so it can never answer an /api/v1 request — an unmatched API path must
    // stay a 404 rather than returning HTML a client would try to parse.
    app.get(/^\/(?!api(\/|$)).*/, (_req, res) => {
      res.sendFile(join(deps.uiRoot!, "index.html"));
    });
  }

  app.use(errorHandler());

  return app;
}
