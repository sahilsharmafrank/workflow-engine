import { StepRegistry } from "@wfe/core";
import { Router } from "express";
import { readFileSync } from "fs";
import { join } from "path";
import { buildOpenApiSpec } from "../openapi/spec";

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

export function systemRoutes(deps?: { registry?: StepRegistry }): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/version", (_req, res) => {
    res.json(getVersion());
  });

  if (deps?.registry) {
    const spec = buildOpenApiSpec(deps.registry);

    router.get("/openapi.json", (_req, res) => {
      res.json(spec);
    });

    router.get("/filter-configuration", (_req, res) => {
      const stepTypes = deps.registry!.list().map((r) => r.type);
      res.json({
        definitions: [
          { field: "status", type: "enum", values: ["draft", "published", "archived"] },
          { field: "name", type: "text" },
        ],
        runs: [
          { field: "status", type: "enum", values: [
            "starting", "running", "complete", "failed", "cancelled", "cancelling", "waiting", "paused",
          ] },
          { field: "name", type: "text" },
          { field: "createdDate", type: "dateRange" },
        ],
        steps: [
          { field: "status", type: "enum", values: [
            "new", "running", "complete", "failed", "cancelled", "waiting", "skipped",
          ] },
          { field: "stepType", type: "enum", values: stepTypes },
          { field: "externalServiceName", type: "text" },
        ],
      });
    });
  }

  return router;
}
