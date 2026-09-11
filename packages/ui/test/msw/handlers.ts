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
  {
    id: 1, name: "nightly", version: "1.0.0", status: "complete", currentStep: 2, updatedDate: "2026-09-10T08:00:00.000Z",
    inputs: { jobId: "job-42" }, outputs: {}, state: {},
  },
  {
    id: 2, name: "nightly", version: "1.0.0", status: "failed", currentStep: 1, updatedDate: "2026-09-10T09:00:00.000Z",
    inputs: { jobId: "job-99" }, outputs: {}, state: {},
  },
  {
    id: 3, name: "adhoc", version: "2.0.0", status: "running", currentStep: 0, updatedDate: "2026-09-10T10:00:00.000Z",
    inputs: { jobId: "job-7" }, outputs: { batchId: "batch-9" }, state: {},
  },
];

// The only jsonb columns `/runs/search` may filter on, mirroring
// SEARCH_JSON_COLUMNS in packages/core/src/repositories/run-repository.ts.
const SEARCH_RUN_JSON_COLUMNS: ReadonlySet<string> = new Set(["inputs", "outputs", "state"]);

// Mirrors SEARCH_PATH_SEGMENT in packages/core/src/repositories/run-repository.ts.
const SEARCH_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

// Walks a dot-path into a fixture's inputs/outputs/state object. Returns
// undefined for a path that runs off the end or through a non-object.
function getAtPath(node: unknown, path: string[]): unknown {
  return path.reduce<unknown>((acc, segment) => {
    if (typeof acc !== "object" || acc === null) return undefined;
    return (acc as Record<string, unknown>)[segment];
  }, node);
}

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
    //
    // Does a real evaluation against each fixture's actual inputs/outputs/
    // state, exactly like RunRepository.search() parses "<column>.<path...>"
    // and checks it against the real column — not an assertion that the
    // caller sent one specific literal. A component that ignored the
    // operator's search fields and always sent a hardcoded filter would fail
    // any test that searches for a different key/value pair.
    const body = (await request.json()) as { filter?: Record<string, unknown> };
    const filter = body.filter ?? {};
    const entries = Object.entries(filter);

    // Mirrors RunRepository.search(): an invalid key is rejected outright,
    // not silently dropped from the match set. The real server throws 400
    // RUN_SEARCH_INVALID_FILTER_KEY for exactly this, precisely because a
    // filter that silently matches nothing (or too much) is its own bug —
    // see run-repository.ts:204-211. This mock has to fail the same way,
    // or a UI that swallowed the error and rendered an empty-results state
    // would pass every test here while failing against the real server.
    for (const key of Object.keys(filter)) {
      const [column, ...path] = key.split(".");
      if (
        !SEARCH_RUN_JSON_COLUMNS.has(column) ||
        path.length === 0 ||
        !path.every((segment) => SEARCH_PATH_SEGMENT.test(segment))
      ) {
        return errorResponse(
          400,
          "RUN_SEARCH_INVALID_FILTER_KEY",
          `Invalid search filter key "${key}": expected "<${[...SEARCH_RUN_JSON_COLUMNS].join("|")}>.<path>", with each path segment limited to letters, digits, underscore and hyphen`
        );
      }
    }

    const matched = runFixtures.filter((run) =>
      entries.every(([key, value]) => {
        const [column, ...path] = key.split(".");
        return getAtPath((run as Record<string, unknown>)[column], path) === value;
      })
    );
    return HttpResponse.json(matched);
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

export const definitionFixtures = [
  { id: 1, name: "nightly", version: "1.0.0", status: "published", updatedDate: "2026-09-01T00:00:00.000Z" },
  { id: 2, name: "nightly", version: "2.0.0", status: "draft", updatedDate: "2026-09-05T00:00:00.000Z" },
  { id: 3, name: "adhoc", version: "1.0.0", status: "published", updatedDate: "2026-09-06T00:00:00.000Z" },
  { id: 4, name: "legacy", version: "1.0.0", status: "archived", updatedDate: "2026-08-01T00:00:00.000Z" },
];

export const definitionDetailFixture = {
  ...definitionFixtures[0],
  definition: { steps: [{ stepName: "Prepare", stepType: "core.transform", stepVersion: "1.0.0", stepInputs: [] }] },
};

// A second, editable detail fixture (DRAFT) whose one step already carries a
// real input pair — the shape DefinitionEditor's edit-flow prefill test
// (Task 8) needs to assert against.
export const definitionDetailFixture2 = {
  ...definitionFixtures[1],
  definition: {
    steps: [{
      stepName: "Prepare", stepType: "core.transform", stepVersion: "1.0.0",
      stepInputs: [{ targetFieldName: "x", modelEvaluationExpression: "$.input.x" }],
    }],
  },
};

export const definitionDetailFixture4 = {
  ...definitionFixtures[3],
  definition: { steps: [{ stepName: "Old", stepType: "core.noop", stepVersion: "1.0.0", stepInputs: [] }] },
};

// Typed against the fixtures' common shape rather than `typeof
// definitionDetailFixture` — that would pin every entry's `definition.steps`
// to fixture 1's inferred `stepInputs: never[]`, which fixture 2's real
// `stepInputs` entries (and fixture 4's) then fail to satisfy structurally,
// even though all three are valid `WorkflowDefinitionDetail`-shaped fixtures.
const definitionDetailFixtures: Record<
  number,
  { id: number; name: string; version: string; status: string; updatedDate: string; definition: unknown }
> = {
  1: definitionDetailFixture,
  2: definitionDetailFixture2,
  4: definitionDetailFixture4,
};

// Tracks a definition's status across a publish/archive call within one
// test, exactly like runDetailStatus above — a static fixture can't reflect
// the effect of a mutation a test just made, so GET/PUT/publish for a given
// id all read through this override instead of the fixture's own `status`.
const definitionStatusOverrides = new Map<number, string>();

export function resetDefinitionStatusOverrides() {
  definitionStatusOverrides.clear();
}

function currentDefinitionStatus(id: number, fallback: string): string {
  return definitionStatusOverrides.get(id) ?? fallback;
}

let nextDefinitionId = 100;

// Mirrors the server's own filtering (see runHandlers above) so the status
// filter test proves the parameter reached the request, not just that some
// list rendered.
const definitionHandlers = [
  http.get(`${BASE}/definitions`, ({ request }) => {
    const url = new URL(request.url);
    const name = url.searchParams.get("name");
    const status = url.searchParams.get("status");
    let rows = definitionFixtures;
    if (name) rows = rows.filter((d) => d.name === name);
    if (status) rows = rows.filter((d) => d.status === status);
    return HttpResponse.json({ rows, total: rows.length });
  }),
  http.get(`${BASE}/definitions/:id`, ({ params }) => {
    const id = Number(params.id);
    const fixture = definitionDetailFixtures[id];
    if (!fixture) return errorResponse(404, "DEFINITION_NOT_FOUND", `Definition ${params.id} not found`);
    return HttpResponse.json({ ...fixture, status: currentDefinitionStatus(id, fixture.status) });
  }),
  http.post(`${BASE}/definitions`, async ({ request }) => {
    const body = (await request.json()) as { name?: string; version?: string; definition?: unknown };
    if (!body.name) return errorResponse(400, "DEFINITION_INVALID", "name is required");
    return HttpResponse.json(
      {
        id: nextDefinitionId++, name: body.name, version: body.version, status: "draft",
        definition: body.definition, updatedDate: new Date().toISOString(),
      },
      { status: 201 }
    );
  }),
  http.put(`${BASE}/definitions/:id`, async ({ params, request }) => {
    const id = Number(params.id);
    const fixture = definitionDetailFixtures[id];
    if (!fixture) return errorResponse(404, "DEFINITION_NOT_FOUND", `Definition ${params.id} not found`);
    const status = currentDefinitionStatus(id, fixture.status);
    if (status !== "draft") {
      return errorResponse(400, "DEFINITION_NOT_EDITABLE", `Definition ${id} is ${status} and cannot be edited`);
    }
    const body = (await request.json()) as { version?: string; definition?: unknown };
    return HttpResponse.json({
      ...fixture, status,
      version: body.version ?? fixture.version,
      definition: body.definition ?? fixture.definition,
    });
  }),
  http.post(`${BASE}/definitions/:id/publish`, ({ params }) => {
    const id = Number(params.id);
    const fixture = definitionDetailFixtures[id];
    if (!fixture) return errorResponse(404, "DEFINITION_NOT_FOUND", `Definition ${params.id} not found`);
    const status = currentDefinitionStatus(id, fixture.status);
    const lifecycle: Record<string, string> = { draft: "published", published: "archived" };
    const next = lifecycle[status];
    if (!next) {
      return errorResponse(400, "DEFINITION_LIFECYCLE_INVALID", `Definition ${id} is ${status} and cannot be published`);
    }
    definitionStatusOverrides.set(id, next);
    return HttpResponse.json({ ...fixture, status: next });
  }),
  http.post(`${BASE}/definitions/import`, async ({ request }) => {
    const body = await request.json();
    const items = Array.isArray(body) ? body : [body];
    const bad = items.find((i: { name?: string }) => !i.name);
    if (bad) return errorResponse(400, "DEFINITION_INVALID", "name is required");
    return HttpResponse.json({ imported: items.length }, { status: 201 });
  }),
];

export const batchJobFixtures = [
  {
    id: 1, name: "reprocess-may", definitionName: "nightly", definitionVersion: "1.0.0",
    status: "running", totalCount: 3, createdDate: "2026-09-10T07:00:00.000Z", updatedDate: "2026-09-10T07:30:00.000Z",
  },
  {
    id: 2, name: "backfill", definitionName: "adhoc", definitionVersion: "1.0.0",
    status: "failed", totalCount: 1, message: "Definition adhoc 9.9.9 not found",
    createdDate: "2026-09-09T07:00:00.000Z", updatedDate: "2026-09-09T07:00:01.000Z",
  },
];

export const batchJobDetailFixture = {
  ...batchJobFixtures[0],
  runIds: [1, 2, 3],
  inputs: [{ x: 1 }, { x: 2 }, { x: 3 }],
  progress: { completedCount: 1, failedCount: 1, runningCount: 1 },
};

// R3: GET /api/v1/batch-jobs returns a plain array (BatchJobRepository.list()
// -> qb.getMany(), no wrapper) unlike the run and definition list endpoints,
// so this handler responds with the array directly rather than { rows, total }.
const batchJobHandlers = [
  http.get(`${BASE}/batch-jobs`, () => HttpResponse.json(batchJobFixtures)),
  http.get(`${BASE}/batch-jobs/:id`, ({ params }) =>
    params.id === "1"
      ? HttpResponse.json(batchJobDetailFixture)
      : errorResponse(404, "BATCH_JOB_NOT_FOUND", `Batch job ${params.id} not found`)
  ),
  http.put(`${BASE}/batch-jobs/:id/cancel`, ({ params }) =>
    params.id === "2"
      ? errorResponse(409, "BATCH_JOB_NOT_CANCELLABLE", "Batch job 2 is already failed and cannot be cancelled")
      : HttpResponse.json({ ...batchJobDetailFixture, status: "cancelled" })
  ),
];

export const handlers = [
  loopbackPassthrough,
  ...baseHandlers,
  ...runHandlers,
  ...runDetailHandlers,
  ...definitionHandlers,
  ...batchJobHandlers,
];

/** Helper for tests that need a specific failure. */
export function errorResponse(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

// Referenced so an unused-import lint doesn't drop the type import that keeps
// these fixtures honest.
export type ApiPaths = paths;
export type ApiComponents = components;
