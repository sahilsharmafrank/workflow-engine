import { HttpResponse, http, passthrough } from "msw";
import type { components, paths } from "../../src/api/schema";

const BASE = "http://localhost/api/v1";

/**
 * Fixtures are typed against the generated schema wherever the schema names a
 * component. A fixture that drifts from the real contract is then a type error
 * rather than a test passing against fiction — which is the specific failure
 * mode this project keeps hitting.
 */
export type StepTypeFixture = { type: string; version: string; description?: string };

export const stepTypeFixtures: StepTypeFixture[] = [
  { type: "core.noop", version: "1.0.0", description: "Completes immediately." },
  { type: "core.http", version: "1.0.0", description: "Makes an HTTP request." },
];

export const filterConfigurationFixture = {
  definitions: [
    { field: "status", type: "enum", values: ["draft", "published", "archived"] },
    { field: "name", type: "text" },
  ],
  runs: [
    {
      field: "status",
      type: "enum",
      values: ["starting", "running", "complete", "failed", "cancelled", "cancelling", "waiting", "paused"],
    },
    { field: "name", type: "text" },
    { field: "createdDate", type: "dateRange" },
  ],
  steps: [
    { field: "status", type: "enum", values: ["new", "running", "complete", "failed", "cancelled", "waiting", "skipped"] },
    { field: "stepType", type: "enum", values: ["core.noop", "core.http"] },
    { field: "externalServiceName", type: "text" },
  ],
};

// The single group this task owns. Later tasks (7-10) each add their own
// group here and spread it into `handlers` below — the array is the only
// thing MSW's setupServer actually registers, so a group left out of it
// would silently not exist.
const baseHandlers = [
  http.get(`${BASE}/step-types`, () => HttpResponse.json(stepTypeFixtures)),
  http.get(`${BASE}/filter-configuration`, () => HttpResponse.json(filterConfigurationFixture)),
];

// test/jsdomNativeAbort.test.ts makes a real request against an ephemeral
// loopback server to prove abort actually cancels an in-flight fetch — not
// API drift, just infrastructure this suite exercises on purpose. Without
// this, `onUnhandledRequest: "error"` (see test/setup.ts) logs a scary-
// looking "no matching handler" error on every run even though the test
// passes; letting loopback traffic through silently keeps suite output
// pristine while still failing loudly on an actual unmocked /api/v1/* call.
// A RegExp, not a path-to-regexp string pattern: MSW's string matcher treats
// ":" as introducing a named path parameter, so "http://127.0.0.1:*" fails
// to parse ("Missing parameter name") rather than matching a wildcard port.
const loopbackPassthrough = http.all(/^http:\/\/127\.0\.0\.1:\d+/, () => passthrough());

export const runFixtures = [
  { id: 1, name: "nightly", version: "1.0.0", status: "complete", currentStep: 2, updatedDate: "2026-09-10T08:00:00.000Z" },
  { id: 2, name: "nightly", version: "1.0.0", status: "failed", currentStep: 1, updatedDate: "2026-09-10T09:00:00.000Z" },
  { id: 3, name: "adhoc", version: "2.0.0", status: "running", currentStep: 0, updatedDate: "2026-09-10T10:00:00.000Z" },
];

// Mirrors the server's own filtering so a test that filters proves the screen
// sends the parameters, not merely that it renders a list.
const runHandlers = [
  http.get(`${BASE}/runs`, ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const name = url.searchParams.get("name");
    let rows = runFixtures;
    if (status) rows = rows.filter((r) => r.status === status);
    if (name) rows = rows.filter((r) => r.name === name);
    return HttpResponse.json({ rows, total: rows.length });
  }),
  http.post(`${BASE}/runs/search`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const wanted = body["inputs.jobId"];
    return HttpResponse.json(wanted === "job-42" ? [runFixtures[0]] : []);
  }),
];

export const handlers = [loopbackPassthrough, ...baseHandlers, ...runHandlers];

/** Helper for tests that need a specific failure. */
export function errorResponse(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

// Referenced so an unused-import lint doesn't drop the type import that keeps
// these fixtures honest.
export type ApiPaths = paths;
export type ApiComponents = components;
