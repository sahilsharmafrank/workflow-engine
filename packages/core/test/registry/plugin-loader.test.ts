import "reflect-metadata";
import { StepRegistry } from "../../src/registry/step-registry";
import { loadPlugins } from "../../src/registry/plugin-loader";

describe("loadPlugins", () => {
  it("loads a plugin module and registers its step types", async () => {
    const registry = new StepRegistry();
    const pluginPath = require.resolve("../../../../examples/sample-plugin");
    await loadPlugins([pluginPath], registry);
    expect(registry.has("sample.echo")).toBe(true);
  });

  it("throws PLUGIN_INVALID for a module with no callable export", async () => {
    const registry = new StepRegistry();
    // JSON files have no default function export
    const jsonPath = require.resolve("../../../../package.json");
    await expect(loadPlugins([jsonPath], registry)).rejects.toMatchObject({
      code: "PLUGIN_INVALID",
    });
  });

  it("throws PLUGIN_LOAD_FAILED for a non-existent module", async () => {
    const registry = new StepRegistry();
    await expect(loadPlugins(["./does-not-exist-xyz"], registry)).rejects.toMatchObject({
      code: "PLUGIN_LOAD_FAILED",
    });
  });
});
