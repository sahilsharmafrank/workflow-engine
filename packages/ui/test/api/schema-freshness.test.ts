import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateApiTypes } from "../../scripts/generate-api-types";

const COMMITTED = resolve(__dirname, "../../src/api");

describe("generated API artefacts", () => {
  it("match a fresh generation", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wfe-api-"));
    await generateApiTypes(tmp);

    const hint =
      "The committed API client is stale. Re-run: npm run generate:api -w @wfe/ui";

    // Compared byte-for-byte on purpose. This is the check that turns "the
    // client matches the server" from a hope into a fact: a route added or
    // changed in buildOpenApiSpec without regenerating fails here instead of
    // silently shipping a UI that calls an endpoint shaped differently.
    expect(readFileSync(join(tmp, "openapi.json"), "utf8"), hint).toBe(
      readFileSync(join(COMMITTED, "openapi.json"), "utf8")
    );
    expect(readFileSync(join(tmp, "schema.d.ts"), "utf8"), hint).toBe(
      readFileSync(join(COMMITTED, "schema.d.ts"), "utf8")
    );
  }, 30000);
});
