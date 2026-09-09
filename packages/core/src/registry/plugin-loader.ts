import { Logger } from "@wfe/sdk";
import { WfeError } from "../errors";
import { createLogger } from "../logging";
import { StepRegistry } from "./step-registry";

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
      mod = await import(spec);
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
