import path from "node:path";
import "reflect-metadata";
import { StepRegistry } from "../../src/registry/step-registry";
import { loadPlugins } from "../../src/registry/plugin-loader";

const repoRoot = path.resolve(__dirname, "../../../..");

describe("loadPlugins", () => {
  it("loads a plugin module and registers its step types", async () => {
    const registry = new StepRegistry();
    const pluginPath = require.resolve("../../../../examples/sample-plugin");
    await loadPlugins([pluginPath], registry);
    expect(registry.has("sample.echo")).toBe(true);
  });

  it("resolves a relative specifier against process.cwd(), not this module's own directory", async () => {
    const originalCwd = process.cwd();
    process.chdir(repoRoot);
    try {
      const registry = new StepRegistry();
      // A naive `require(spec)`/`import(spec)` of this exact string would
      // resolve relative to plugin-loader.ts's own directory (several levels
      // deep under dist/), not the process's cwd — and fail to find it.
      await loadPlugins(["./examples/sample-plugin/index.ts"], registry);
      expect(registry.has("sample.echo")).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("resolves a relative directory specifier via its package.json main field", async () => {
    const originalCwd = process.cwd();
    process.chdir(repoRoot);
    try {
      const registry = new StepRegistry();
      // No filename — README documents WFE_PLUGINS as accepting a bare
      // directory path, matching the ./examples/sample-plugin example.
      await loadPlugins(["./examples/sample-plugin"], registry);
      expect(registry.has("sample.echo")).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
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
