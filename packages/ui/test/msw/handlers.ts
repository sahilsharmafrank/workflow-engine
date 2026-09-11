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
    // Mirrors the controller, which reads `req.body.filter` (not the body
    // itself) — packages/server/src/controllers/runs.ts. A handler that read
    // the top level, like the request itself, would agree with a client bug
    // that silently drops the filter in production.
    const body = (await request.json()) as { filter?: Record<string, unknown> };
    const wanted = body.filter?.["inputs.jobId"];
    return HttpResponse.json(wanted === "job-42" ? [runFixtures[0]] : []);
  }),
];

export const runDetailFixture = {
  id: 2,
  name: "nightly",
  version: "1.0.0",
  status: "failed",
  currentStep: 1,
  updatedDate: "2026-09-10T09:00:00.000Z",
  parentRunId: null,
  depth: 0,
  inputs: { jobId: "job-42" },
  outputs: {},
  state: {},
  stepRuns: [
    { id: 10, stepNumber: 0, stepName: "Prepare", stepType: "core.transform", status: "complete", message: null, inputs: { a: 1 }, outputs: { b: 2 }, state: {} },
    { id: 11, stepNumber: 1, stepName: "Call", stepType: "core.http", status: "failed", message: "connect ECONNREFUSED", inputs: {}, outputs: {}, state: {} },
  ],
};

// A separate fixture, not a mutation of runDetailFixture, so the existing
// no-parent tests (and the stateful status above) keep meaning unchanged.
// Exercises the sub-workflow lineage link added to workflow_run in Phase 4.
export const childRunDetailFixture = {
  id: 5,
  name: "nightly",
  version: "1.0.0",
  status: "complete",
  currentStep: 1,
  updatedDate: "2026-09-10T09:30:00.000Z",
  parentRunId: 2,
  depth: 1,
  inputs: {},
  outputs: {},
  state: {},
  stepRuns: [
    { id: 20, stepNumber: 0, stepName: "Sub-step", stepType: "core.noop", status: "complete", message: null, inputs: {}, outputs: {}, state: {} },
  ],
};

// Held outside the fixture object itself so GET can reflect a restart's
// effect and a test can observe a genuine state change rather than a
// refetch racing a static fixture back to "failed" (see task-8-report.md,
// ruling P4). resetRunDetailStatus() is called from the shared afterEach so
// a restart in one test can't leak "running" into the next.
let runDetailStatus: string = runDetailFixture.status;

export function resetRunDetailStatus() {
  runDetailStatus = runDetailFixture.status;
}

const runDetailHandlers = [
  http.get(`${BASE}/runs/:id`, ({ params }) => {
    if (params.id === "2") return HttpResponse.json({ ...runDetailFixture, status: runDetailStatus });
    if (params.id === String(childRunDetailFixture.id)) return HttpResponse.json(childRunDetailFixture);
    return errorResponse(404, "RUN_NOT_FOUND", `Run ${params.id} not found`);
  }),
  http.put(`${BASE}/runs/:id/cancel`, () =>
    errorResponse(409, "RUN_NOT_CANCELLABLE", "Run 2 is already failed and cannot be cancelled")
  ),
  http.put(`${BASE}/runs/:id/restart/step/:n`, () => {
    runDetailStatus = "running";
    return HttpResponse.json({ ...runDetailFixture, status: runDetailStatus });
  }),
];

export const handlers = [loopbackPassthrough, ...baseHandlers, ...runHandlers, ...runDetailHandlers];

/** Helper for tests that need a specific failure. */
export function errorResponse(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

// Referenced so an unused-import lint doesn't drop the type import that keeps
// these fixtures honest.
export type ApiPaths = paths;
export type ApiComponents = components;
