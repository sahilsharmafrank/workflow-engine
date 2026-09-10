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

  // buildOpenApiSpec is typed as a plain Record<string, unknown>, while
  // openapiTS's first parameter is a union of source forms (string | URL |
  // Readable | OpenAPI3 | Buffer). The two have no structural overlap as far
  // as the type checker is concerned — even asserting directly to the
  // narrower OpenAPI3 member of that union fails, since Record<string,
  // unknown> doesn't statically guarantee OpenAPI3's required `openapi`/
  // `info` properties — even though the value is a valid OpenAPI document at
  // runtime. Going through `unknown` is required to bypass that check.
  const ast = await openapiTS(spec as unknown as Parameters<typeof openapiTS>[0]);
  writeFileSync(join(outDir, "schema.d.ts"), `${HEADER}${astToString(ast)}`, "utf8");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  await generateApiTypes(resolve(here, "../src/api"));
  console.log("Wrote src/api/openapi.json and src/api/schema.d.ts");
}
