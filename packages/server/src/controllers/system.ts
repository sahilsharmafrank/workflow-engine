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
