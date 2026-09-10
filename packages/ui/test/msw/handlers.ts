import { HttpResponse, http } from "msw";
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

export const handlers = [...baseHandlers];

/** Helper for tests that need a specific failure. */
export function errorResponse(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

// Referenced so an unused-import lint doesn't drop the type import that keeps
// these fixtures honest.
export type ApiPaths = paths;
export type ApiComponents = components;
