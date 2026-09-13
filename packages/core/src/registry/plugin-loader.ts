import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Logger } from "@wfe/sdk";
import { WfeError } from "../errors";
import { createLogger } from "../logging";
import { StepRegistry } from "./step-registry";

const INDEX_CANDIDATES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

/** Finds a directory plugin's entry point: package.json's main/module field, else an index file. */
function resolveDirectoryEntry(dir: string): string {
  const pkgPath = path.join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { main?: string; module?: string };
    const entry = pkg.main ?? pkg.module;
    if (typeof entry === "string") {
      return path.join(dir, entry);
    }
  }
  for (const candidate of INDEX_CANDIDATES) {
    const candidatePath = path.join(dir, candidate);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  throw new Error(
    `no entry point found in plugin directory "${dir}" (no package.json main/module field, no index.{ts,js,mjs,cjs})`,
  );
}

/**
 * Resolves a WFE_PLUGINS entry to something `import()` can load.
 *
 * A bare specifier (no leading "." and not absolute) is left untouched — it's
 * an npm package name, resolved by Node's normal node_modules lookup.
 *
 * A path specifier is resolved against `process.cwd()`, not against this
 * module's own location: a naive `import(spec)` resolves a relative path
 * relative to the *importing file* — here, this module's compiled location
 * deep under dist/ — which doesn't match what an operator setting
 * WFE_PLUGINS=./my-plugin from the project root means.
 *
 * A path that resolves to a directory is further resolved to that
 * directory's entry point, since Node's ESM loader refuses to import a bare
 * directory even when it has a package.json `main` field.
 */
function resolveSpecifier(spec: string): string {
  const isPathSpecifier = spec.startsWith(".") || path.isAbsolute(spec);
  if (!isPathSpecifier) {
    return spec;
  }
  const resolved = path.isAbsolute(spec) ? spec : path.resolve(process.cwd(), spec);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return resolveDirectoryEntry(resolved);
  }
  return resolved;
}

export async function loadPlugins(
  specifiers: string[],
  registry: StepRegistry,
  logger?: Logger,
): Promise<void> {
  const log = logger ?? createLogger("plugin-loader");

  for (const spec of specifiers) {
    log.info("Loading plugin", { specifier: spec });
    let mod: Record<string, unknown>;
    try {
      mod = await import(resolveSpecifier(spec));
    } catch (err) {
      throw new WfeError(`Failed to load plugin "${spec}": ${(err as Error).message}`, {
        statusCode: 500,
        code: "PLUGIN_LOAD_FAILED",
        cause: err as Error,
      });
    }

    const register = (mod.default ?? mod) as unknown;
    if (typeof register !== "function") {
      throw new WfeError(
        `Plugin "${spec}" has no callable default export (got ${typeof register})`,
        { statusCode: 500, code: "PLUGIN_INVALID" },
      );
    }

    const result = register(registry);
    if (result && typeof (result as Promise<void>).then === "function") {
      await result;
    }

    log.info("Plugin loaded", { specifier: spec, registeredTypes: registry.list().map((r) => r.type) });
  }
}
