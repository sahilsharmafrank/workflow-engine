import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StepRegistry, registerBuiltInSteps } from "@wfe/core";
import { buildOpenApiSpec } from "@wfe/server";
import openapiTS, { astToString } from "openapi-typescript";

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 * Regenerate with: npm run generate:api -w @wfe/ui
 */
`;

/**
 * Writes openapi.json and schema.d.ts into outDir. Exported so the freshness
 * test can generate into a temp directory and compare, rather than trusting
 * that whoever changed a route remembered to re-run this.
 */
export async function generateApiTypes(outDir: string): Promise<void> {
  const registry = new StepRegistry();
  registerBuiltInSteps(registry);
  const spec = buildOpenApiSpec(registry);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "openapi.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8");

  const ast = await openapiTS(spec as Parameters<typeof openapiTS>[0]);
  writeFileSync(join(outDir, "schema.d.ts"), `${HEADER}${astToString(ast)}`, "utf8");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  await generateApiTypes(resolve(here, "../src/api"));
  console.log("Wrote src/api/openapi.json and src/api/schema.d.ts");
}
