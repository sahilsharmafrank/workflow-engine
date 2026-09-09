import express, { Express } from "express";
import { RunExecutor, StepRegistry, DbContext, QueueDriver } from "@wfe/core";
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
  app.use(systemRoutes());
  app.use("/api/v1", systemRoutes());

  // All /api/v1 routes below this point require tenant resolution
  app.use("/api/v1", tenantMiddleware(deps.authProvider));

  // Route controllers will be mounted here in Tasks 2–5

  app.use(errorHandler());

  return app;
}
