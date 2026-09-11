import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/app";
import { NoneAuthProvider } from "../src/auth/none-provider";
import { StepRegistry, registerBuiltInSteps } from "@wfe/core";

function appWithUi(uiRoot?: string) {
  const registry = new StepRegistry();
  registerBuiltInSteps(registry);
  return createApp({
    // These routes never touch the database, so the engine deps can be stubs.
    executor: {} as never,
    db: {} as never,
    evaluator: {} as never,
    registry,
    authProvider: new NoneAuthProvider(),
    uiRoot,
  });
}

describe("static UI serving", () => {
  const root = mkdtempSync(join(tmpdir(), "wfe-ui-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>ui</title>");
  writeFileSync(join(root, "app.js"), "console.log('hi');");

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("serves index.html at the root", async () => {
    const res = await request(appWithUi(root)).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<title>ui</title>");
  });

  it("serves a built asset", async () => {
    const res = await request(appWithUi(root)).get("/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("console.log");
  });

  it("falls back to index.html for a client-side route", async () => {
    // A refresh on /runs/42 must not 404 — the SPA router owns that path.
    const res = await request(appWithUi(root)).get("/runs/42");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<title>ui</title>");
  });

  it("does not shadow the API", async () => {
    // The fallback must never answer an /api/v1 request, or a mistyped API
    // path would return HTML and a client would parse it as JSON.
    const res = await request(appWithUi(root)).get("/api/v1/no-such-route");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("<title>ui</title>");
  });

  it("does not shadow a bare /api with no trailing slash", async () => {
    // The guard's lookahead was `(?!api\/)`, which only excludes "api"
    // followed by a literal slash — "/api" itself (no trailing slash) slipped
    // through and matched the SPA fallback, returning 200 HTML instead of a
    // 404. Fixed to `(?!api(\/|$))` so "api" at the end of the path is
    // excluded too.
    const res = await request(appWithUi(root)).get("/api");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("<title>ui</title>");
  });

  it("still answers the API when no UI is configured", async () => {
    const res = await request(appWithUi(undefined)).get("/api/v1/health");
    expect(res.status).toBe(200);
  });
});
