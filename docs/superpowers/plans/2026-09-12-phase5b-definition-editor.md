# Phase 5b — Definition Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator create, edit (while DRAFT), publish, and archive a
workflow definition entirely through the UI, with the server refusing to let
a non-DRAFT definition's body change underneath runs already executing
against it.

**Architecture:** One React screen, `DefinitionEditor`, used for both
`/definitions/new` (empty initial state, `useCreateDefinition`) and
`/definitions/:id/edit` (pre-filled from `useDefinition`,
`useUpdateDefinition`) — the id's presence is what distinguishes create from
edit. Steps render as a list of `StepEditor` cards, each embedding three
`CaptureExpressionList` instances (inputs/outputs/stateCapture) plus an
optional `PreFlightCheckEditor`. A read-only `JsonView` panel shows the
assembled document live. Client-side validation covers required fields only;
everything else (duplicate names, unknown types, lifecycle errors) is a
server response surfaced verbatim through an enhanced `ErrorState`. Two
backend fixes carry this phase: `DefinitionRepository.update()` gains a
DRAFT-only status guard, and the UI's `ApiError` stops dropping the server's
per-field `details` array.

**Tech Stack:** React + MUI v5, TanStack Query v5, react-router-dom v6,
openapi-fetch generated client, Vitest + Testing Library + MSW (UI), Jest +
testcontainers Postgres (core), Express (server).

**Spec:** `docs/superpowers/specs/2026-09-12-phase5b-definition-editor-design.md`

## Global Constraints

- No client-side reimplementation of server validation rules beyond
  required-field checks (empty step name, empty step version, zero
  `stepInputs`, empty definition `version`, empty `name` on create) — every
  other rejection (`DEFINITION_DUPLICATE_STEP_NAME`,
  `DEFINITION_UNKNOWN_STEP_TYPE`, `DEFINITION_MISSING_STEP_TYPE`,
  `DEFINITION_INVALID`, `DEFINITION_LIFECYCLE_INVALID`,
  `DEFINITION_NOT_EDITABLE`) is surfaced verbatim from the server response.
- Reordering steps is up/down buttons only — no drag-and-drop, no new
  dependency.
- Only a DRAFT definition's body/version may change; enforcement is
  server-side (`DEFINITION_NOT_EDITABLE`), not just a hidden UI button.
- Editing a definition's `name` is out of scope — only `version` and the
  step body are exposed for edit.
- Every assertion in a new or modified test must name a mutation that would
  make it fail — no rendered-and-didn't-crash assertions.
- Regenerate `packages/ui/src/api/openapi.json` and `schema.d.ts`
  (`npm run generate:api -w @wfe/ui`) after any `buildOpenApiSpec` change —
  `packages/ui/test/api/schema-freshness.test.ts` fails until that runs.

---

## Task 1: Core — `DefinitionRepository.update()` status guard

**Files:**
- Modify: `packages/core/src/repositories/definition-repository.ts:69-90`
- Test: `packages/core/test/repositories/repositories.test.ts`

**Interfaces:**
- Consumes: nothing new — `WorkflowDefinitionStatus` is already imported in
  `definition-repository.ts` from `@wfe/sdk`; `WfeError` is already imported
  from `../errors`.
- Produces: `update()` now throws `WfeError` with `statusCode: 400, code:
  "DEFINITION_NOT_EDITABLE"` when the existing row's `status` is not
  `WorkflowDefinitionStatus.DRAFT`. Every later task that edits a definition
  (the server controller already calls `update()` unchanged, the UI's
  `useUpdateDefinition` in Task 4) relies on this exact code.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/repositories/repositories.test.ts`, after the
existing `"ignores a draft when looking for a published definition"` test
(around line 63), still inside the `describe("repositories", ...)` block and
still able to see the top-level `const body = { steps: [] };`:

```ts
  it("rejects updating a published definition", async () => {
    const created = await definitions.create({
      tenantId: "default", name: "wf-e", version: "1.0.0",
      definition: body, status: WorkflowDefinitionStatus.PUBLISHED,
    });
    await expect(
      definitions.update("default", created.id!, { version: "1.0.1" })
    ).rejects.toMatchObject({ code: "DEFINITION_NOT_EDITABLE", statusCode: 400 });
  });

  it("updates a draft definition", async () => {
    const created = await definitions.create({
      tenantId: "default", name: "wf-f", version: "1.0.0", definition: body,
    });
    const updated = await definitions.update("default", created.id!, { version: "1.0.1" });
    expect(updated.version).toBe("1.0.1");
  });
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `npm run test -w @wfe/core -- -t "rejects updating a published definition"`
Expected: FAIL — `update()` currently saves the row instead of throwing, so
`.rejects` never resolves to a rejection.

- [ ] **Step 3: Add the status guard**

In `packages/core/src/repositories/definition-repository.ts`, inside
`update()`, right after the "not found" check and before
`existing.lastUpdateHistory = ...`:

```ts
    if (existing.status !== WorkflowDefinitionStatus.DRAFT) {
      throw new WfeError(
        `Definition ${id} is ${existing.status} and cannot be edited`,
        { statusCode: 400, code: "DEFINITION_NOT_EDITABLE" }
      );
    }
```

- [ ] **Step 4: Run the tests to verify both pass**

Run: `npm run test -w @wfe/core -- -t "updating a published definition|updates a draft definition"`
Expected: PASS for both.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/repositories/definition-repository.ts packages/core/test/repositories/repositories.test.ts
git commit -m "fix(core): reject DefinitionRepository.update() on a non-draft definition"
```

---

## Task 2: UI infra — `ApiError` carries `details`, `ErrorState` renders them

**Files:**
- Modify: `packages/ui/src/api/client.ts`
- Modify: `packages/ui/src/components/ErrorState.tsx`
- Test: `packages/ui/test/components/ErrorState.test.tsx` (new)

**Interfaces:**
- Produces: `export interface ApiErrorDetail { path?: string; message: string }`
  and `ApiError` gains a fourth constructor param / readonly field
  `details?: ApiErrorDetail[]`. `ErrorState` renders a `<ul>` (MUI `List`,
  implicit `role="list"`) of `"<path>: <message>"` lines when `details` is a
  non-empty array. Every later screen that renders `ErrorState` for a
  `DEFINITION_INVALID` response (Task 8, Task 9) relies on this.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/test/components/ErrorState.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client";
import { ErrorState } from "../../src/components/ErrorState";

describe("ErrorState", () => {
  it("renders the message and code", () => {
    render(<ErrorState error={new ApiError(400, "DEFINITION_INVALID", "Invalid workflow definition")} />);
    expect(screen.getByText("Invalid workflow definition")).toBeInTheDocument();
    expect(screen.getByText("DEFINITION_INVALID")).toBeInTheDocument();
  });

  it("renders a details list when present", () => {
    render(
      <ErrorState
        error={new ApiError(400, "DEFINITION_INVALID", "Invalid workflow definition", [
          { path: "steps[0].stepName", message: "steps[0].stepName is a required field" },
          { path: "steps[1].stepVersion", message: "steps[1].stepVersion is a required field" },
        ])}
      />
    );
    expect(screen.getByText("steps[0].stepName: steps[0].stepName is a required field")).toBeInTheDocument();
    expect(screen.getByText("steps[1].stepVersion: steps[1].stepVersion is a required field")).toBeInTheDocument();
  });

  it("renders no list when details is absent", () => {
    render(<ErrorState error={new ApiError(404, "DEFINITION_NOT_FOUND", "Definition 9 not found")} />);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("falls back to a generic message for a non-ApiError", () => {
    render(<ErrorState error={new Error("boom")} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wfe/ui -- ErrorState.test.tsx`
Expected: FAIL — `ApiError`'s constructor does not yet accept a fourth
`details` argument (a TypeScript error), and `ErrorState` renders no list.

- [ ] **Step 3: Add `details` to `ApiError` and `unwrap()`**

In `packages/ui/src/api/client.ts`, replace the whole file's error-handling
section (the `ApiError` class, `ServerErrorBody` interface, and `unwrap()`)
with:

```ts
export interface ApiErrorDetail {
  path?: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorDetail[]
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// R1: the generated schema's path keys already carry the /api/v1 prefix
// (e.g. "/api/v1/step-types"), so the base URL is empty and every call site
// uses the full prefixed path literal. A non-empty "/api/v1" base would
// double the prefix.
export const api = createClient<paths>({ baseUrl: "" });

interface ServerErrorBody {
  error?: { code?: string; message?: string; details?: ApiErrorDetail[] };
}

/**
 * Every server error is `{ error: { code, message, details? } }`, so this is
 * the single place that shape is parsed. Screens receive an ApiError
 * carrying the code (and, when the server sent one, the per-field details
 * list) and never touch a response body.
 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    const body = result.error as ServerErrorBody | undefined;
    throw new ApiError(
      result.response.status,
      body?.error?.code ?? "UNKNOWN",
      body?.error?.message ?? `Request failed with status ${result.response.status}`,
      body?.error?.details
    );
  }
  return result.data as T;
}
```

- [ ] **Step 4: Render the details list in `ErrorState`**

Replace `packages/ui/src/components/ErrorState.tsx`'s `ErrorState` function
(keep `EmptyState`/`NotFoundState` as-is):

```tsx
import { Alert, List, ListItem, Paper, Typography } from "@mui/material";
import { ApiError } from "../api/client";

export function ErrorState({ error }: { error: unknown }) {
  const code = error instanceof ApiError ? error.code : undefined;
  const details = error instanceof ApiError ? error.details : undefined;
  const message = error instanceof Error ? error.message : "Unexpected error";
  return (
    <Alert severity="error" sx={{ my: 2 }}>
      {message}
      {code && (
        <Typography variant="caption" display="block">
          {code}
        </Typography>
      )}
      {details && details.length > 0 && (
        <List dense disablePadding>
          {details.map((d, i) => (
            <ListItem key={i} disableGutters sx={{ display: "list-item", pl: 2 }}>
              <Typography variant="caption">
                {d.path ? `${d.path}: ` : ""}
                {d.message}
              </Typography>
            </ListItem>
          ))}
        </List>
      )}
    </Alert>
  );
}
```

(Only the `ErrorState` export changes; leave the `Alert`/`Paper`/`Typography`
import already used by `EmptyState`/`NotFoundState` intact — just extend the
import line to add `List, ListItem`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w @wfe/ui -- ErrorState.test.tsx`
Expected: PASS, all 4 tests.

- [ ] **Step 6: Run the full UI suite to confirm no regression**

Run: `npm run test -w @wfe/ui`
Expected: PASS — every screen that already renders `ErrorState` (Definitions,
DefinitionDetail, RunDetail, BatchJobs, BatchJobDetail) keeps working since
`details` is optional.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/api/client.ts packages/ui/src/components/ErrorState.tsx packages/ui/test/components/ErrorState.test.tsx
git commit -m "feat(ui): surface server-side per-field validation details in ErrorState"
```

---

## Task 3: Server — tighten the Definitions OpenAPI endpoints, regenerate the client

**Files:**
- Modify: `packages/server/src/openapi/spec.ts:40-98`
- (generated, do not hand-edit) `packages/ui/src/api/openapi.json`, `packages/ui/src/api/schema.d.ts`

**Interfaces:**
- Produces: `POST /api/v1/definitions`, `PUT /api/v1/definitions/{id}`, and
  `POST /api/v1/definitions/{id}/publish` now document response bodies
  (`WorkflowDefinition` on success, `ErrorEnvelope` on 400/404) instead of a
  bare description. `PUT`'s request body is typed
  `{ name?, version?, definition? }` instead of a bare `object`. No schema
  change to `ErrorEnvelope` itself — it already declares an optional
  `details` field (`packages/server/src/openapi/spec.ts:509-523`); the design
  doc's "add `details` to ErrorEnvelope" is already satisfied and this task
  does not repeat it.
- Consumes: `WorkflowDefinition` and `ErrorEnvelope` schema refs, both
  already defined in the same file's `components.schemas`.

- [ ] **Step 1: Edit the three path entries**

In `packages/server/src/openapi/spec.ts`, replace the `"/api/v1/definitions"`
block (lines 40–60) with:

```ts
      "/api/v1/definitions": {
        get: {
          summary: "List workflow definitions",
          operationId: "listDefinitions",
          tags: ["Definitions"],
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["draft", "published", "archived"] } },
            { name: "name", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { 200: { description: "Paginated list of definitions", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkflowDefinitionList" } } } } },
        },
        post: {
          summary: "Create a workflow definition",
          operationId: "createDefinition",
          tags: ["Definitions"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    version: { type: "string" },
                    definition: { type: "object", additionalProperties: true },
                  },
                  required: ["name", "version", "definition"],
                },
              },
            },
          },
          responses: {
            201: { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkflowDefinition" } } } },
            400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
      },
```

Then replace the `"/api/v1/definitions/{id}"` block (originally lines
61–80) with:

```ts
      "/api/v1/definitions/{id}": {
        get: {
          summary: "Get a workflow definition",
          operationId: "getDefinition",
          tags: ["Definitions"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: { description: "Definition", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkflowDefinition" } } } },
            404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
        put: {
          summary: "Update a workflow definition",
          operationId: "updateDefinition",
          tags: ["Definitions"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    version: { type: "string" },
                    definition: { type: "object", additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkflowDefinition" } } } },
            400: { description: "Validation error or non-draft definition", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
            404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
      },
```

And replace the `"/api/v1/definitions/{id}/publish"` block (originally
lines 81–89) with:

```ts
      "/api/v1/definitions/{id}/publish": {
        post: {
          summary: "Publish (or archive) a definition",
          operationId: "publishDefinition",
          tags: ["Definitions"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: { description: "Status transitioned", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkflowDefinition" } } } },
            400: { description: "Invalid transition", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
            404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
      },
```

Leave `"/api/v1/definitions/import"` untouched — out of scope for this
phase (§9 of the design doc).

- [ ] **Step 2: Build `@wfe/server` so the UI's generator sees the change**

`packages/ui/scripts/generate-api-types.ts` imports `buildOpenApiSpec` from
`@wfe/server`, which resolves to `packages/server/dist` (its package.json
`main`) — the edit in Step 1 is invisible to the generator until the server
package is rebuilt.

Run: `npm run build -w @wfe/server`
Expected: exits 0, `packages/server/dist` updated.

- [ ] **Step 3: Regenerate the UI's API client artifacts**

Run: `npm run generate:api -w @wfe/ui`
Expected: `Wrote src/api/openapi.json and src/api/schema.d.ts`, and
`git diff --stat packages/ui/src/api/` shows both files changed.

- [ ] **Step 4: Run the drift test to confirm the regeneration matches**

Run: `npm run test -w @wfe/ui -- schema-freshness.test.ts`
Expected: PASS — a fresh generation now matches what's committed because
Step 3 just committed that exact fresh generation.

- [ ] **Step 5: Run the full server and UI suites to confirm no regression**

Run: `npm run test -w @wfe/server && npm run test -w @wfe/ui`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/openapi/spec.ts packages/ui/src/api/openapi.json packages/ui/src/api/schema.d.ts
git commit -m "feat(server): tighten OpenAPI request/response schemas for the Definitions write endpoints"
```

---

## Task 4: UI hooks + MSW fixtures for definition create/update/publish

**Files:**
- Modify: `packages/ui/src/api/hooks/useDefinitions.ts`
- Modify: `packages/ui/test/msw/handlers.ts`
- Modify: `packages/ui/test/setup.ts`
- Test: `packages/ui/test/api/useDefinitions.mutations.test.tsx` (new)

**Interfaces:**
- Produces:
  - `useDefinition(id: number, options?: { enabled?: boolean }): UseQueryResult<WorkflowDefinitionDetail>`
    (adds the `options` param; existing call in `DefinitionDetail.tsx`
    keeps compiling unchanged since it's optional).
  - `useCreateDefinition(): UseMutationResult` — `mutate({ name: string,
    version: string, definition: unknown })` → `WorkflowDefinitionDetail`.
  - `useUpdateDefinition(): UseMutationResult` — `mutate({ id: number,
    version?: string, definition?: unknown })` → `WorkflowDefinitionDetail`.
  - `usePublishDefinition(): UseMutationResult` — `mutate(id: number)` →
    `WorkflowDefinitionDetail`.
  - All three mutation hooks invalidate `["definitions"]`; update/publish
    also invalidate `["definition", id]`.
- Consumes: `api`, `unwrap`, `ApiError` from `../client`
  (`packages/ui/src/api/client.ts`, Task 2).

- [ ] **Step 1: Write the failing hook tests**

Create `packages/ui/test/api/useDefinitions.mutations.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client";
import {
  useCreateDefinition, usePublishDefinition, useUpdateDefinition,
} from "../../src/api/hooks/useDefinitions";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("definition mutation hooks", () => {
  it("creates a definition", async () => {
    const { result } = renderHook(() => useCreateDefinition(), { wrapper });
    result.current.mutate({ name: "new-wf", version: "1.0.0", definition: { steps: [] } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.name).toBe("new-wf");
    expect(result.current.data?.status).toBe("draft");
  });

  it("updates a draft definition", async () => {
    const { result } = renderHook(() => useUpdateDefinition(), { wrapper });
    result.current.mutate({ id: 2, version: "2.0.1", definition: { steps: [] } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.version).toBe("2.0.1");
  });

  it("surfaces DEFINITION_NOT_EDITABLE when updating a published definition", async () => {
    const { result } = renderHook(() => useUpdateDefinition(), { wrapper });
    result.current.mutate({ id: 1, version: "1.0.1", definition: { steps: [] } });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe("DEFINITION_NOT_EDITABLE");
  });

  it("publishes a draft definition", async () => {
    const { result } = renderHook(() => usePublishDefinition(), { wrapper });
    result.current.mutate(2);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe("published");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @wfe/ui -- useDefinitions.mutations.test.tsx`
Expected: FAIL — `useCreateDefinition`/`useUpdateDefinition`/
`usePublishDefinition` don't exist yet (TypeScript error), and no MSW
handler exists for `POST /definitions`, `PUT /definitions/:id`, or `POST
/definitions/:id/publish` beyond the current stubs.

- [ ] **Step 3: Add the mutation hooks and the `enabled` option**

In `packages/ui/src/api/hooks/useDefinitions.ts`, replace the existing
`useDefinition` function (lines 63–73) with:

```ts
export function useDefinition(id: number, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["definition", id],
    enabled: options?.enabled,
    queryFn: async (): Promise<WorkflowDefinitionDetail> => {
      const result = await api.GET("/api/v1/definitions/{id}", { params: { path: { id } } });
      // Same `updatedDate` optional-vs-required gap as useDefinitions above:
      // WorkflowDefinition declares it optional, WorkflowDefinitionDetail
      // requires it. The cast stays for that reason, not a real mismatch.
      return unwrap(result) as WorkflowDefinitionDetail;
    },
  });
}

export function useCreateDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      version: string;
      definition: unknown;
    }): Promise<WorkflowDefinitionDetail> =>
      unwrap(await api.POST("/api/v1/definitions", { body: input as never })) as WorkflowDefinitionDetail,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["definitions"] }),
  });
}

export function useUpdateDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: number;
      version?: string;
      definition?: unknown;
    }): Promise<WorkflowDefinitionDetail> =>
      unwrap(
        await api.PUT("/api/v1/definitions/{id}", {
          params: { path: { id: input.id } },
          body: { version: input.version, definition: input.definition } as never,
        })
      ) as WorkflowDefinitionDetail,
    onSuccess: (_data, input) => {
      qc.invalidateQueries({ queryKey: ["definitions"] });
      qc.invalidateQueries({ queryKey: ["definition", input.id] });
    },
  });
}

export function usePublishDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number): Promise<WorkflowDefinitionDetail> =>
      unwrap(
        await api.POST("/api/v1/definitions/{id}/publish", { params: { path: { id } } })
      ) as WorkflowDefinitionDetail,
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["definitions"] });
      qc.invalidateQueries({ queryKey: ["definition", id] });
    },
  });
}
```

- [ ] **Step 4: Add MSW fixtures and handlers**

In `packages/ui/test/msw/handlers.ts`, replace the `definitionFixtures` /
`definitionDetailFixture` / `definitionHandlers` block (lines 216–252) with:

```ts
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

const definitionDetailFixtures: Record<number, typeof definitionDetailFixture> = {
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
```

- [ ] **Step 5: Reset the new override map between tests**

In `packages/ui/test/setup.ts`, change the import on line 4 to:

```ts
import { resetDefinitionStatusOverrides, resetRunDetailStatus } from "./msw/handlers";
```

and change the `afterEach` block (lines 145–148) to:

```ts
afterEach(() => {
  mswServer.resetHandlers();
  resetRunDetailStatus();
  resetDefinitionStatusOverrides();
});
```

- [ ] **Step 6: Run the hook tests to verify they pass**

Run: `npm run test -w @wfe/ui -- useDefinitions.mutations.test.tsx`
Expected: PASS, all 4 tests.

- [ ] **Step 7: Run the full UI suite to confirm no regression**

Run: `npm run test -w @wfe/ui`
Expected: PASS — `Definitions.test.tsx` and `DefinitionDetail.test.tsx`
still pass unchanged against the restructured fixtures (id 1's shape and the
"nightly" name filter are preserved).

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/api/hooks/useDefinitions.ts packages/ui/test/msw/handlers.ts packages/ui/test/setup.ts packages/ui/test/api/useDefinitions.mutations.test.tsx
git commit -m "feat(ui): add create/update/publish definition hooks and their MSW fixtures"
```

---

## Task 5: Component — `CaptureExpressionList`

**Files:**
- Create: `packages/ui/src/components/CaptureExpressionList.tsx`
- Test: `packages/ui/test/components/CaptureExpressionList.test.tsx` (new)

**Interfaces:**
- Produces:
  ```ts
  interface Props {
    label: string;
    value: ParameterCaptureExpression[]; // from @wfe/sdk
    onChange: (next: ParameterCaptureExpression[]) => void;
  }
  export function CaptureExpressionList(props: Props): JSX.Element;
  ```
  A row's field-name input is labeled `"${label} field name ${i + 1}"`, its
  expression input `"${label} expression ${i + 1}"`, the remove button
  `"Remove ${label} row ${i + 1}"`, and the add button `"Add ${label.toLowerCase()} row"`.
  `StepEditor` (Task 7) and `PreFlightCheckEditor` (Task 6) both mount this
  with those exact label conventions.
- Consumes: `ParameterCaptureExpression` type from `@wfe/sdk`.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/test/components/CaptureExpressionList.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CaptureExpressionList } from "../../src/components/CaptureExpressionList";

describe("CaptureExpressionList", () => {
  it("renders a row per entry with its field name and expression", () => {
    render(
      <CaptureExpressionList
        label="Inputs"
        value={[{ targetFieldName: "jobId", modelEvaluationExpression: "$.input.jobId" }]}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Inputs field name 1")).toHaveValue("jobId");
    expect(screen.getByLabelText("Inputs expression 1")).toHaveValue("$.input.jobId");
  });

  it("adds a blank row on Add", async () => {
    const onChange = vi.fn();
    render(<CaptureExpressionList label="Inputs" value={[]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add inputs row" }));
    expect(onChange).toHaveBeenCalledWith([{ targetFieldName: "", modelEvaluationExpression: "" }]);
  });

  it("removes a row without disturbing the others", async () => {
    const onChange = vi.fn();
    const value = [
      { targetFieldName: "a", modelEvaluationExpression: "1" },
      { targetFieldName: "b", modelEvaluationExpression: "2" },
    ];
    render(<CaptureExpressionList label="Inputs" value={value} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Remove Inputs row 1"));
    expect(onChange).toHaveBeenCalledWith([{ targetFieldName: "b", modelEvaluationExpression: "2" }]);
  });

  it("edits a field in place without disturbing other rows", async () => {
    const onChange = vi.fn();
    const value = [{ targetFieldName: "a", modelEvaluationExpression: "1" }];
    render(<CaptureExpressionList label="Inputs" value={value} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Inputs field name 1"), "x");
    expect(onChange).toHaveBeenLastCalledWith([{ targetFieldName: "ax", modelEvaluationExpression: "1" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wfe/ui -- CaptureExpressionList.test.tsx`
Expected: FAIL — the module doesn't exist.

- [ ] **Step 3: Implement the component**

Create `packages/ui/src/components/CaptureExpressionList.tsx`:

```tsx
import { Add, Delete } from "@mui/icons-material";
import { Button, IconButton, Stack, TextField, Typography } from "@mui/material";
import type { ParameterCaptureExpression } from "@wfe/sdk";

interface Props {
  label: string;
  value: ParameterCaptureExpression[];
  onChange: (next: ParameterCaptureExpression[]) => void;
}

/**
 * Add/remove editor for a list of {targetFieldName, modelEvaluationExpression}
 * pairs — the shape shared by stepInputs, stepOutputs, stepStateCapture and
 * preFlightCheck.conditionsToCheck (packages/sdk/src/types.ts).
 */
export function CaptureExpressionList({ label, value, onChange }: Props) {
  function update(index: number, field: keyof ParameterCaptureExpression, next: string) {
    onChange(value.map((row, i) => (i === index ? { ...row, [field]: next } : row)));
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...value, { targetFieldName: "", modelEvaluationExpression: "" }]);
  }

  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{label}</Typography>
      {value.map((row, i) => (
        <Stack key={i} direction="row" spacing={1} alignItems="center">
          <TextField
            size="small"
            label={`${label} field name ${i + 1}`}
            value={row.targetFieldName}
            onChange={(e) => update(i, "targetFieldName", e.target.value)}
          />
          <TextField
            size="small"
            label={`${label} expression ${i + 1}`}
            value={row.modelEvaluationExpression}
            onChange={(e) => update(i, "modelEvaluationExpression", e.target.value)}
            sx={{ flexGrow: 1 }}
          />
          <IconButton aria-label={`Remove ${label} row ${i + 1}`} onClick={() => remove(i)} size="small">
            <Delete fontSize="small" />
          </IconButton>
        </Stack>
      ))}
      <Button size="small" startIcon={<Add />} onClick={add} sx={{ alignSelf: "flex-start" }}>
        Add {label.toLowerCase()} row
      </Button>
    </Stack>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @wfe/ui -- CaptureExpressionList.test.tsx`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/CaptureExpressionList.tsx packages/ui/test/components/CaptureExpressionList.test.tsx
git commit -m "feat(ui): add CaptureExpressionList editor"
```

---

## Task 6: Component — `PreFlightCheckEditor`

**Files:**
- Create: `packages/ui/src/components/PreFlightCheckEditor.tsx`
- Test: `packages/ui/test/components/PreFlightCheckEditor.test.tsx` (new)

**Interfaces:**
- Consumes: `CaptureExpressionList` (Task 5) with `label="Conditions to
  check"`. `PreFlightCheckParameters`, `PreFlightCheckActionOutcome` from
  `@wfe/sdk`.
- Produces:
  ```ts
  interface Props {
    value: PreFlightCheckParameters | undefined;
    onChange: (next: PreFlightCheckParameters) => void;
  }
  export function PreFlightCheckEditor(props: Props): JSX.Element;
  ```
  Renders an empty-conditions/`FAIL`-action check when `value` is
  `undefined` (the caller, `StepEditor` in Task 7, is what decides whether
  `preFlightCheck` is present at all on the step — this component only
  edits an already-present-or-defaulted check). The action dropdown is
  labeled `"Action on failure"`, the message field `"Failure message"`.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/test/components/PreFlightCheckEditor.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreFlightCheckActionOutcome } from "@wfe/sdk";
import { describe, expect, it, vi } from "vitest";
import { PreFlightCheckEditor } from "../../src/components/PreFlightCheckEditor";

describe("PreFlightCheckEditor", () => {
  it("renders the given conditions, action and message", () => {
    const value = {
      conditionsToCheck: [{ targetFieldName: "x", modelEvaluationExpression: "$.state.x" }],
      actionOnFailure: PreFlightCheckActionOutcome.SKIP,
      failureMessage: "skip when x set",
    };
    render(<PreFlightCheckEditor value={value} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Conditions to check field name 1")).toHaveValue("x");
    expect(screen.getByLabelText("Action on failure")).toHaveValue("skip");
    expect(screen.getByLabelText("Failure message")).toHaveValue("skip when x set");
  });

  it("defaults to an empty condition list and a fail action when value is undefined", () => {
    render(<PreFlightCheckEditor value={undefined} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Action on failure")).toHaveValue("fail");
    expect(screen.queryByLabelText(/Conditions to check field name/)).not.toBeInTheDocument();
  });

  it("propagates a condition-list edit merged with the rest of the check", async () => {
    const onChange = vi.fn();
    const value = {
      conditionsToCheck: [{ targetFieldName: "x", modelEvaluationExpression: "1" }],
      actionOnFailure: PreFlightCheckActionOutcome.FAIL,
    };
    render(<PreFlightCheckEditor value={value} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add conditions to check row" }));
    expect(onChange).toHaveBeenCalledWith({
      ...value,
      conditionsToCheck: [...value.conditionsToCheck, { targetFieldName: "", modelEvaluationExpression: "" }],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wfe/ui -- PreFlightCheckEditor.test.tsx`
Expected: FAIL — the module doesn't exist.

- [ ] **Step 3: Implement the component**

Create `packages/ui/src/components/PreFlightCheckEditor.tsx`:

```tsx
import { MenuItem, Stack, TextField } from "@mui/material";
import { PreFlightCheckActionOutcome } from "@wfe/sdk";
import type { PreFlightCheckParameters } from "@wfe/sdk";
import { CaptureExpressionList } from "./CaptureExpressionList";

interface Props {
  value: PreFlightCheckParameters | undefined;
  onChange: (next: PreFlightCheckParameters) => void;
}

const EMPTY_CHECK: PreFlightCheckParameters = {
  conditionsToCheck: [],
  actionOnFailure: PreFlightCheckActionOutcome.FAIL,
};

/**
 * A step's preflight check is optional at the definition level — absent
 * means "no check" (packages/sdk/src/types.ts). Whether the check exists at
 * all is the caller's decision (StepEditor's checkbox); this component only
 * edits the fields of one that already exists, defaulting to an empty one
 * so it always has something to render.
 */
export function PreFlightCheckEditor({ value, onChange }: Props) {
  const check = value ?? EMPTY_CHECK;

  return (
    <Stack spacing={1}>
      <CaptureExpressionList
        label="Conditions to check"
        value={check.conditionsToCheck}
        onChange={(conditionsToCheck) => onChange({ ...check, conditionsToCheck })}
      />
      <TextField
        select
        size="small"
        label="Action on failure"
        value={check.actionOnFailure}
        onChange={(e) => onChange({ ...check, actionOnFailure: e.target.value as PreFlightCheckActionOutcome })}
        sx={{ maxWidth: 240 }}
      >
        {Object.values(PreFlightCheckActionOutcome).map((v) => (
          <MenuItem key={v} value={v}>{v}</MenuItem>
        ))}
      </TextField>
      <TextField
        size="small"
        label="Failure message"
        value={check.failureMessage ?? ""}
        onChange={(e) => onChange({ ...check, failureMessage: e.target.value })}
      />
    </Stack>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @wfe/ui -- PreFlightCheckEditor.test.tsx`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/PreFlightCheckEditor.tsx packages/ui/test/components/PreFlightCheckEditor.test.tsx
git commit -m "feat(ui): add PreFlightCheckEditor"
```

---

## Task 7: Component — `StepEditor`

**Files:**
- Create: `packages/ui/src/components/StepEditor.tsx`
- Test: `packages/ui/test/components/StepEditor.test.tsx` (new)

**Interfaces:**
- Consumes: `CaptureExpressionList` (Task 5) x3 (labels `"Inputs"`,
  `"Outputs"`, `"State capture"`), `PreFlightCheckEditor` (Task 6),
  `StepDefinition` and `PreFlightCheckActionOutcome` from `@wfe/sdk`,
  `StepType` from `../api/hooks/useStepTypes`.
- Produces:
  ```ts
  interface Props {
    index: number;
    step: StepDefinition;
    stepTypes: StepType[];
    canMoveUp: boolean;
    canMoveDown: boolean;
    onChange: (next: StepDefinition) => void;
    onRemove: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
  }
  export function StepEditor(props: Props): JSX.Element;
  ```
  Text fields labeled `"Step name"`, `"Step version"`, `"Step type"`
  (an `Autocomplete freeSolo` — dropdown from `stepTypes`, free text
  accepted). Buttons: `"Move step ${index+1} up"`, `"Move step ${index+1}
  down"`, `"Remove step ${index+1}"`. A `"Preflight check"` checkbox toggles
  `step.preFlightCheck` between `undefined` and a default check object.
  `DefinitionEditor` (Task 8) renders one of these per step.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/test/components/StepEditor.test.tsx`. It wraps
`StepEditor` in a small stateful harness so `Autocomplete`'s controlled
`inputValue` actually reflects each keystroke (the exact same reason
`DefinitionEditor` itself, Task 8, must hold `steps` in `useState` rather
than as a plain prop):

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StepDefinition } from "@wfe/sdk";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { StepEditor } from "../../src/components/StepEditor";
import type { StepType } from "../../src/api/hooks/useStepTypes";

const stepTypes: StepType[] = [{ type: "core.noop", version: "1.0.0" }, { type: "core.http", version: "1.0.0" }];

function initialStep(): StepDefinition {
  return { stepName: "", stepVersion: "", stepType: "", stepInputs: [] };
}

function Harness({ onChange }: { onChange?: (s: StepDefinition) => void }) {
  const [step, setStep] = useState<StepDefinition>(initialStep());
  return (
    <StepEditor
      index={0}
      step={step}
      stepTypes={stepTypes}
      canMoveUp={false}
      canMoveDown={false}
      onChange={(next) => { setStep(next); onChange?.(next); }}
      onRemove={vi.fn()}
      onMoveUp={vi.fn()}
      onMoveDown={vi.fn()}
    />
  );
}

describe("StepEditor", () => {
  it("edits name, version and step type", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Step name"), "Prepare");
    await userEvent.type(screen.getByLabelText("Step version"), "1.0.0");
    await userEvent.type(screen.getByLabelText("Step type"), "core.transform");
    expect(screen.getByLabelText("Step name")).toHaveValue("Prepare");
    expect(screen.getByLabelText("Step version")).toHaveValue("1.0.0");
    expect(screen.getByLabelText("Step type")).toHaveValue("core.transform");
  });

  it("adds an inputs row via the embedded CaptureExpressionList", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Add inputs row" }));
    expect(screen.getByLabelText("Inputs field name 1")).toHaveValue("");
  });

  it("shows the preflight check editor only once its checkbox is checked", async () => {
    render(<Harness />);
    expect(screen.queryByLabelText("Action on failure")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Preflight check" }));
    expect(screen.getByLabelText("Action on failure")).toHaveValue("fail");
  });

  it("hiding the preflight check again clears it back to undefined", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Preflight check" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Preflight check" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ preFlightCheck: undefined }));
  });

  it("disables Move up when it is the first step", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Move step 1 up" })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wfe/ui -- StepEditor.test.tsx`
Expected: FAIL — the module doesn't exist.

- [ ] **Step 3: Implement the component**

Create `packages/ui/src/components/StepEditor.tsx`:

```tsx
import { ArrowDownward, ArrowUpward, Delete, ExpandMore } from "@mui/icons-material";
import {
  Accordion, AccordionDetails, AccordionSummary, Autocomplete, Checkbox,
  FormControlLabel, IconButton, Stack, TextField, Typography,
} from "@mui/material";
import type { StepDefinition } from "@wfe/sdk";
import { PreFlightCheckActionOutcome } from "@wfe/sdk";
import type { StepType } from "../api/hooks/useStepTypes";
import { CaptureExpressionList } from "./CaptureExpressionList";
import { PreFlightCheckEditor } from "./PreFlightCheckEditor";

interface Props {
  index: number;
  step: StepDefinition;
  stepTypes: StepType[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (next: StepDefinition) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

/**
 * One step's fields inside DefinitionEditor's step list (design doc §6):
 * name/version/type, the three capture-expression lists, and an optional
 * preflight check.
 */
export function StepEditor({
  index, step, stepTypes, canMoveUp, canMoveDown, onChange, onRemove, onMoveUp, onMoveDown,
}: Props) {
  function set<K extends keyof StepDefinition>(field: K, val: StepDefinition[K]) {
    onChange({ ...step, [field]: val });
  }

  function togglePreFlightCheck(enabled: boolean) {
    set(
      "preFlightCheck",
      enabled ? { conditionsToCheck: [], actionOnFailure: PreFlightCheckActionOutcome.FAIL } : undefined
    );
  }

  return (
    <Accordion defaultExpanded>
      <AccordionSummary expandIcon={<ExpandMore />}>
        <Typography>{step.stepName || `Step ${index + 1}`}</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1}>
            <IconButton aria-label={`Move step ${index + 1} up`} disabled={!canMoveUp} onClick={onMoveUp} size="small">
              <ArrowUpward fontSize="small" />
            </IconButton>
            <IconButton aria-label={`Move step ${index + 1} down`} disabled={!canMoveDown} onClick={onMoveDown} size="small">
              <ArrowDownward fontSize="small" />
            </IconButton>
            <IconButton aria-label={`Remove step ${index + 1}`} onClick={onRemove} size="small">
              <Delete fontSize="small" />
            </IconButton>
          </Stack>

          <Stack direction="row" spacing={2} flexWrap="wrap">
            <TextField
              size="small" required label="Step name"
              value={step.stepName}
              onChange={(e) => set("stepName", e.target.value)}
            />
            <TextField
              size="small" required label="Step version"
              value={step.stepVersion}
              onChange={(e) => set("stepVersion", e.target.value)}
            />
            <Autocomplete
              freeSolo
              size="small"
              options={stepTypes.map((t) => t.type)}
              inputValue={step.stepType ?? ""}
              onInputChange={(_, next) => set("stepType", next)}
              renderInput={(params) => <TextField {...params} required label="Step type" />}
              sx={{ minWidth: 220 }}
            />
          </Stack>

          <CaptureExpressionList
            label="Inputs"
            value={step.stepInputs}
            onChange={(stepInputs) => set("stepInputs", stepInputs)}
          />
          <CaptureExpressionList
            label="Outputs"
            value={step.stepOutputs ?? []}
            onChange={(stepOutputs) => set("stepOutputs", stepOutputs)}
          />
          <CaptureExpressionList
            label="State capture"
            value={step.stepStateCapture ?? []}
            onChange={(stepStateCapture) => set("stepStateCapture", stepStateCapture)}
          />

          <FormControlLabel
            control={
              <Checkbox
                checked={step.preFlightCheck !== undefined}
                onChange={(e) => togglePreFlightCheck(e.target.checked)}
              />
            }
            label="Preflight check"
          />
          {step.preFlightCheck && (
            <PreFlightCheckEditor
              value={step.preFlightCheck}
              onChange={(preFlightCheck) => set("preFlightCheck", preFlightCheck)}
            />
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @wfe/ui -- StepEditor.test.tsx`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/StepEditor.tsx packages/ui/test/components/StepEditor.test.tsx
git commit -m "feat(ui): add StepEditor"
```

---

## Task 8: Screen — `DefinitionEditor` (create + edit)

**Files:**
- Create: `packages/ui/src/screens/DefinitionEditor.tsx`
- Test: `packages/ui/test/screens/DefinitionEditor.test.tsx` (new)

**Interfaces:**
- Consumes: `StepEditor` (Task 7), `useCreateDefinition`,
  `useUpdateDefinition`, `useDefinition` (Task 4), `useStepTypes`,
  `ErrorState` (Task 2), `JsonView`, `ApiError`. Reads `id` from
  `useParams()` — present means edit mode, absent means create mode (design
  doc §6).
- Produces: `export function DefinitionEditor(): JSX.Element`, mounted at
  both `/definitions/new` and `/definitions/:id/edit` by Task 9's
  `routes.tsx` change.

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/test/screens/DefinitionEditor.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DefinitionEditor } from "../../src/screens/DefinitionEditor";
import { renderWithProviders } from "../renderWithProviders";

function DetailStub() {
  const { id } = useParams();
  return <div>navigated to {id}</div>;
}

function renderNew() {
  return renderWithProviders(
    <Routes>
      <Route path="/definitions/new" element={<DefinitionEditor />} />
      <Route path="/definitions/:id" element={<DetailStub />} />
    </Routes>,
    { route: "/definitions/new" }
  );
}

function renderEdit(id: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/definitions/:id/edit" element={<DefinitionEditor />} />
      <Route path="/definitions/:id" element={<DetailStub />} />
    </Routes>,
    { route: `/definitions/${id}/edit` }
  );
}

describe("DefinitionEditor", () => {
  it("blocks Save and shows inline errors when required fields are empty", async () => {
    renderNew();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Name is required.")).toBeInTheDocument();
    expect(screen.getByText("Version is required.")).toBeInTheDocument();
    expect(screen.getByText("At least one step is required.")).toBeInTheDocument();
    expect(screen.queryByText(/navigated to/)).not.toBeInTheDocument();
  });

  it("blocks Save when a step is missing its inputs", async () => {
    renderNew();
    await userEvent.type(screen.getByLabelText("Name"), "wf");
    await userEvent.type(screen.getByLabelText("Version"), "1.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getByLabelText("Step name"), "Only");
    await userEvent.type(screen.getByLabelText("Step version"), "1.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("At least one input is required.")).toBeInTheDocument();
  });

  it("creates a definition from a filled-in form and navigates to its detail page", async () => {
    renderNew();
    await userEvent.type(screen.getByLabelText("Name"), "new-wf");
    await userEvent.type(screen.getByLabelText("Version"), "1.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getByLabelText("Step name"), "Only");
    await userEvent.type(screen.getByLabelText("Step version"), "1.0.0");
    await userEvent.type(screen.getByLabelText("Step type"), "core.transform");
    await userEvent.click(screen.getByRole("button", { name: "Add inputs row" }));
    await userEvent.type(screen.getByLabelText("Inputs field name 1"), "x");
    await userEvent.type(screen.getByLabelText("Inputs expression 1"), "$.input.x");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/navigated to \d+/)).toBeInTheDocument();
  });

  it("pre-fills from the existing draft definition, with name locked, and saves an edit", async () => {
    renderEdit("2");
    expect(await screen.findByLabelText("Name")).toHaveValue("nightly");
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Version")).toHaveValue("2.0.0");
    expect(screen.getByLabelText("Step name")).toHaveValue("Prepare");
    expect(screen.getByLabelText("Inputs field name 1")).toHaveValue("x");

    await userEvent.clear(screen.getByLabelText("Version"));
    await userEvent.type(screen.getByLabelText("Version"), "2.0.1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("navigated to 2")).toBeInTheDocument();
  });

  it("shows a read-only notice instead of the form for a published definition", async () => {
    renderEdit("1");
    expect(await screen.findByText("Only a draft definition can be edited.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Version")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @wfe/ui -- DefinitionEditor.test.tsx`
Expected: FAIL — the module doesn't exist.

- [ ] **Step 3: Implement the screen**

Create `packages/ui/src/screens/DefinitionEditor.tsx`:

```tsx
import { Add } from "@mui/icons-material";
import { Alert, Button, CircularProgress, FormHelperText, Paper, Stack, TextField, Typography } from "@mui/material";
import type { StepDefinition, WorkflowDefinitionBody } from "@wfe/sdk";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCreateDefinition, useDefinition, useUpdateDefinition } from "../api/hooks/useDefinitions";
import { useStepTypes } from "../api/hooks/useStepTypes";
import { ErrorState } from "../components/ErrorState";
import { JsonView } from "../components/JsonView";
import { StepEditor } from "../components/StepEditor";

interface FieldErrors {
  name?: string;
  version?: string;
  steps?: string;
  stepName?: Record<number, string>;
  stepVersion?: Record<number, string>;
  stepInputs?: Record<number, string>;
}

function emptyStep(): StepDefinition {
  return { stepName: "", stepVersion: "", stepType: "", stepInputs: [] };
}

/**
 * Required-field-only client validation (design doc §7): every rule here
 * mirrors a field the server's own yup schema also requires, so this can
 * never disagree with a rejection the server would issue anyway. Everything
 * else — duplicate names, unknown types, DEFINITION_INVALID's own field
 * list — is left to the server response, surfaced verbatim through ErrorState.
 */
function validate(name: string, isCreate: boolean, version: string, steps: StepDefinition[]): FieldErrors {
  const errors: FieldErrors = {};
  if (isCreate && !name.trim()) errors.name = "Name is required.";
  if (!version.trim()) errors.version = "Version is required.";
  if (steps.length === 0) errors.steps = "At least one step is required.";

  for (const [i, step] of steps.entries()) {
    if (!step.stepName.trim()) errors.stepName = { ...errors.stepName, [i]: "Step name is required." };
    if (!step.stepVersion.trim()) errors.stepVersion = { ...errors.stepVersion, [i]: "Step version is required." };
    if (step.stepInputs.length === 0) {
      errors.stepInputs = { ...errors.stepInputs, [i]: "At least one input is required." };
    }
  }
  return errors;
}

function hasErrors(errors: FieldErrors): boolean {
  return Boolean(
    errors.name || errors.version || errors.steps || errors.stepName || errors.stepVersion || errors.stepInputs
  );
}

export function DefinitionEditor() {
  const { id } = useParams();
  const isCreate = id === undefined;
  const navigate = useNavigate();
  const existing = useDefinition(Number(id), { enabled: !isCreate });
  const stepTypes = useStepTypes();
  const createDef = useCreateDefinition();
  const updateDef = useUpdateDefinition();

  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [steps, setSteps] = useState<StepDefinition[]>([]);
  const [touched, setTouched] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Pre-fill from the loaded definition exactly once, when it arrives — not
  // on every render, or a save's own refetch would blow away in-progress edits.
  if (!isCreate && existing.data && !initialized) {
    setName(existing.data.name);
    setVersion(existing.data.version);
    setSteps((existing.data.definition as WorkflowDefinitionBody).steps);
    setInitialized(true);
  }

  const errors = useMemo(() => validate(name, isCreate, version, steps), [name, isCreate, version, steps]);

  if (!isCreate && existing.isLoading) return <CircularProgress />;
  if (!isCreate && existing.error) return <ErrorState error={existing.error} />;
  if (!isCreate && existing.data && existing.data.status !== "draft") {
    return <Alert severity="warning">Only a draft definition can be edited.</Alert>;
  }

  const mutation = isCreate ? createDef : updateDef;

  function onSave() {
    setTouched(true);
    if (hasErrors(errors)) return;
    const body: WorkflowDefinitionBody = { steps };
    if (isCreate) {
      createDef.mutate(
        { name, version, definition: body },
        { onSuccess: (created) => navigate(`/definitions/${created.id}`) }
      );
    } else {
      updateDef.mutate(
        { id: Number(id), version, definition: body },
        { onSuccess: () => navigate(`/definitions/${id}`) }
      );
    }
  }

  function addStep() {
    setSteps([...steps, emptyStep()]);
  }

  function updateStep(index: number, next: StepDefinition) {
    setSteps(steps.map((s, i) => (i === index ? next : s)));
  }

  function removeStep(index: number) {
    setSteps(steps.filter((_, i) => i !== index));
  }

  function moveStep(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    setSteps(next);
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h5">{isCreate ? "New definition" : `Edit ${name} ${version}`}</Typography>

      <Stack direction="row" spacing={2}>
        <TextField
          size="small" label="Name" required
          value={name}
          disabled={!isCreate}
          onChange={(e) => setName(e.target.value)}
          error={touched && Boolean(errors.name)}
          helperText={touched ? errors.name : undefined}
        />
        <TextField
          size="small" label="Version" required
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          error={touched && Boolean(errors.version)}
          helperText={touched ? errors.version : undefined}
        />
      </Stack>

      <Typography variant="h6">Steps</Typography>
      {touched && errors.steps && <FormHelperText error>{errors.steps}</FormHelperText>}
      <Stack spacing={2}>
        {steps.map((step, i) => (
          <Stack key={i} spacing={0.5}>
            <StepEditor
              index={i}
              step={step}
              stepTypes={stepTypes.data ?? []}
              canMoveUp={i > 0}
              canMoveDown={i < steps.length - 1}
              onChange={(next) => updateStep(i, next)}
              onRemove={() => removeStep(i)}
              onMoveUp={() => moveStep(i, -1)}
              onMoveDown={() => moveStep(i, 1)}
            />
            {touched && errors.stepName?.[i] && <FormHelperText error>{errors.stepName[i]}</FormHelperText>}
            {touched && errors.stepVersion?.[i] && <FormHelperText error>{errors.stepVersion[i]}</FormHelperText>}
            {touched && errors.stepInputs?.[i] && <FormHelperText error>{errors.stepInputs[i]}</FormHelperText>}
          </Stack>
        ))}
      </Stack>
      <Button startIcon={<Add />} onClick={addStep} sx={{ alignSelf: "flex-start" }}>
        Add step
      </Button>

      <Typography variant="h6">Preview</Typography>
      <Paper sx={{ p: 2 }}>
        <JsonView value={{ steps }} />
      </Paper>

      {mutation.error && <ErrorState error={mutation.error} />}
      <Button variant="contained" onClick={onSave} disabled={mutation.isPending} sx={{ alignSelf: "flex-start" }}>
        Save
      </Button>
    </Stack>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @wfe/ui -- DefinitionEditor.test.tsx`
Expected: PASS, all 5 tests. If the `Autocomplete`/`inputValue` interaction
in the "creates a definition" or "pre-fills" tests doesn't settle the way
Step 1 assumed, iterate on the component (not the test's intent) until the
typed value is reflected — this is the one part of this task most likely to
need a real red/green loop rather than passing on the first try.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/DefinitionEditor.tsx packages/ui/test/screens/DefinitionEditor.test.tsx
git commit -m "feat(ui): add the DefinitionEditor screen for create and edit"
```

---

## Task 9: Wiring — routes, "New Definition", Edit/Publish/Archive

**Files:**
- Modify: `packages/ui/src/routes.tsx`
- Modify: `packages/ui/src/screens/Definitions.tsx`
- Modify: `packages/ui/src/screens/DefinitionDetail.tsx`
- Test: `packages/ui/test/screens/Definitions.test.tsx` (extend)
- Test: `packages/ui/test/screens/DefinitionDetail.test.tsx` (extend)

**Interfaces:**
- Consumes: `DefinitionEditor` (Task 8), `usePublishDefinition` (Task 4).
- Produces: routes `/definitions/new` and `/definitions/:id/edit`; a "New
  Definition" button on `Definitions`; an "Edit" link (DRAFT only) and a
  status-driven "Publish"/"Archive" button (hidden when ARCHIVED) on
  `DefinitionDetail`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ui/test/screens/Definitions.test.tsx`, inside the
existing `describe("Definitions", ...)` block, after the last `it`:

```tsx
  it("navigates to the new-definition screen", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/definitions" element={<Definitions />} />
        <Route path="/definitions/new" element={<div>New definition screen</div>} />
      </Routes>,
      { route: "/definitions" }
    );
    await screen.findByText("adhoc");
    await userEvent.click(screen.getByRole("button", { name: "New Definition" }));
    expect(await screen.findByText("New definition screen")).toBeInTheDocument();
  });
```

Add the two imports this needs at the top of the file:

```tsx
import { Route, Routes } from "react-router-dom";
```

Append to `packages/ui/test/screens/DefinitionDetail.test.tsx`, inside the
existing `describe("DefinitionDetail", ...)` block:

```tsx
  it("shows Edit and Publish for a draft definition, and switches to Archive after publishing", async () => {
    renderAt("2");
    expect(await screen.findByText("nightly 2.0.0")).toBeInTheDocument();
    // Not asserted by status text here: the "Versions" history table below
    // includes this definition among its own name-siblings (see the
    // pre-existing test above), so its status renders twice on the page —
    // once in the header pill, once in that row — and a plain getByText
    // would fail on the duplicate. The Edit link and the button's own label
    // are unambiguous stand-ins for "this definition is a draft right now".
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute("href", "/definitions/2/edit");
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
  });

  it("hides Edit and the status action for an archived definition", async () => {
    renderAt("4");
    expect(await screen.findByText("legacy 1.0.0")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });
```

Add `userEvent` and `waitFor` to that file's existing imports if not already
present (`waitFor` is not currently imported there — add it alongside
`screen`; the file has no `userEvent` import yet either — add
`import userEvent from "@testing-library/user-event";`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @wfe/ui -- Definitions.test.tsx DefinitionDetail.test.tsx`
Expected: FAIL — no "New Definition" button, no "Edit"/"Publish"/"Archive"
controls yet.

- [ ] **Step 3: Wire up `routes.tsx`**

Replace `packages/ui/src/routes.tsx` entirely:

```tsx
import { Navigate, RouteObject } from "react-router-dom";
import { AppShell } from "./AppShell";
import { BatchJobDetail } from "./screens/BatchJobDetail";
import { BatchJobs } from "./screens/BatchJobs";
import { DefinitionDetail } from "./screens/DefinitionDetail";
import { DefinitionEditor } from "./screens/DefinitionEditor";
import { Definitions } from "./screens/Definitions";
import { RunDetail } from "./screens/RunDetail";
import { RunTracker } from "./screens/RunTracker";
import { StepCatalog } from "./screens/StepCatalog";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/runs" replace /> },
      { path: "runs", element: <RunTracker /> },
      { path: "runs/:id", element: <RunDetail /> },
      { path: "step-types", element: <StepCatalog /> },
      { path: "definitions", element: <Definitions /> },
      { path: "definitions/new", element: <DefinitionEditor /> },
      { path: "definitions/:id", element: <DefinitionDetail /> },
      { path: "definitions/:id/edit", element: <DefinitionEditor /> },
      { path: "batch-jobs", element: <BatchJobs /> },
      { path: "batch-jobs/:id", element: <BatchJobDetail /> },
    ],
  },
];
```

- [ ] **Step 4: Add the "New Definition" button**

In `packages/ui/src/screens/Definitions.tsx`, in the header `Stack`
(currently just the title and the Upload button, lines 49–62), add a button
before Upload:

```tsx
        <Button variant="contained" onClick={() => navigate("/definitions/new")}>
          New Definition
        </Button>
```

(placed right after `<Typography variant="h5">Definitions</Typography>` and
before the existing `<Button component="label" variant="outlined">Upload`).

- [ ] **Step 5: Add Edit/Publish/Archive to `DefinitionDetail`**

Replace `packages/ui/src/screens/DefinitionDetail.tsx` in full:

```tsx
import { Button, CircularProgress, Paper, Stack, Typography } from "@mui/material";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useDefinition, useDefinitions, usePublishDefinition } from "../api/hooks/useDefinitions";
import { ErrorState, NotFoundState } from "../components/ErrorState";
import { Column, DataTable } from "../components/DataTable";
import { JsonView } from "../components/JsonView";
import { StatusPill } from "../components/StatusPill";
import type { WorkflowDefinitionSummary } from "../api/hooks/useDefinitions";

const historyColumns: Column<WorkflowDefinitionSummary>[] = [
  { key: "version", header: "Version", render: (d) => d.version, sortValue: (d) => d.version },
  { key: "status", header: "Status", render: (d) => <StatusPill status={d.status} /> },
  { key: "updatedDate", header: "Updated", render: (d) => new Date(d.updatedDate).toLocaleString(), sortValue: (d) => d.updatedDate },
];

export function DefinitionDetail() {
  const { id } = useParams();
  const { data, isLoading, error } = useDefinition(Number(id));
  // Identity is name + version, so "version history" is just this definition's
  // siblings by name — no dedicated endpoint needed. Gated on `data` so this
  // fires once, with the real name filter, instead of first issuing a wasted
  // unfiltered GET /definitions on every render before the detail resolves.
  const history = useDefinitions(data ? { name: data.name } : {}, { enabled: Boolean(data) });
  const publish = usePublishDefinition();

  if (isLoading) return <CircularProgress />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundState message={error.message} />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  // The single publish endpoint transitions DRAFT->PUBLISHED or
  // PUBLISHED->ARCHIVED depending on current status (DefinitionRepository.publish());
  // the button's label follows the same table so it always names the transition
  // this click will actually perform, and disappears once ARCHIVED has nowhere
  // left to go (design doc §3).
  const publishLabel = data.status === "draft" ? "Publish" : data.status === "published" ? "Archive" : null;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="h5">
          {data.name} {data.version}
        </Typography>
        <StatusPill status={data.status} />
        {data.status === "draft" && (
          <Button component={Link} to={`/definitions/${data.id}/edit`} variant="outlined" size="small">
            Edit
          </Button>
        )}
        {publishLabel && (
          <Button
            variant="outlined" size="small"
            disabled={publish.isPending}
            onClick={() => publish.mutate(data.id)}
          >
            {publishLabel}
          </Button>
        )}
      </Stack>

      {publish.error && <ErrorState error={publish.error} />}

      <Typography variant="h6">Definition</Typography>
      <Paper sx={{ p: 2 }}>
        <JsonView value={data.definition} />
      </Paper>

      <Typography variant="h6">Versions</Typography>
      <DataTable
        columns={historyColumns}
        rows={history.data?.rows ?? []}
        getRowKey={(d) => d.id}
        emptyMessage="No other versions."
      />
    </Stack>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w @wfe/ui -- Definitions.test.tsx DefinitionDetail.test.tsx`
Expected: PASS — including the two pre-existing `DefinitionDetail` tests
(`renderAt("1")` and `renderAt("999")`), unchanged.

- [ ] **Step 7: Run the full UI suite**

Run: `npm run test -w @wfe/ui`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/routes.tsx packages/ui/src/screens/Definitions.tsx packages/ui/src/screens/DefinitionDetail.tsx packages/ui/test/screens/Definitions.test.tsx packages/ui/test/screens/DefinitionDetail.test.tsx
git commit -m "feat(ui): wire up New Definition, Edit, Publish and Archive"
```

---

## Task 10: Contract suite — prove the DRAFT-only rule holds end to end

**Files:**
- Modify: `packages/ui/test/contract/api-contract.test.ts`

**Interfaces:**
- Consumes: the real `client` (`createClient<paths>`) and `createApp()`
  already set up in this file's `beforeAll` — no new setup needed, this task
  only adds `it` blocks.

- [ ] **Step 1: Rebuild `@wfe/core` and `@wfe/server` so the real app under test reflects every source change so far**

This suite imports `createApp` from `@wfe/server` and `DefinitionRepository`,
`validateDefinitionShape`, etc. from `@wfe/core` — both resolve through npm
workspaces to that package's `dist/` (its `package.json` `main`), not its
`src/`. Task 1's `DefinitionRepository.update()` guard and any other core/
server source change since the last build are invisible to this suite until
both packages are rebuilt.

Run: `npm run build -w @wfe/core && npm run build -w @wfe/server`
Expected: both exit 0.

- [ ] **Step 2: Write the new contract test**

Append to `packages/ui/test/contract/api-contract.test.ts`, inside the
existing `describe("generated client against a real server", ...)` block,
after the last `it`:

```ts
  it("creates, edits, publishes and archives a definition, rejecting an edit after publish", async () => {
    const created = await client.POST("/api/v1/definitions", {
      body: {
        name: "contract-editor-target", version: "1.0.0",
        definition: { steps: [{ stepName: "Only", stepVersion: "1.0.0", stepType: "core.transform", stepInputs: [] }] },
      } as never,
    });
    expect(created.response.status).toBe(201);
    const id = created.data!.id;

    const edited = await client.PUT("/api/v1/definitions/{id}", {
      params: { path: { id } },
      body: { version: "1.0.1" } as never,
    });
    expect(edited.data!.version).toBe("1.0.1");

    const published = await client.POST("/api/v1/definitions/{id}/publish", { params: { path: { id } } });
    expect(published.data!.status).toBe("published");

    // This is the assertion this suite exists to make: a definition the UI
    // marks read-only must also be read-only against the real server, not
    // merely against one MSW mock (design doc §8).
    const rejectedEdit = await client.PUT("/api/v1/definitions/{id}", {
      params: { path: { id } },
      body: { version: "1.0.2" } as never,
    });
    expect(rejectedEdit.response.status).toBe(400);
    expect(rejectedEdit.error!.error.code).toBe("DEFINITION_NOT_EDITABLE");

    const archived = await client.POST("/api/v1/definitions/{id}/publish", { params: { path: { id } } });
    expect(archived.data!.status).toBe("archived");
  });
```

- [ ] **Step 3: Run the contract suite**

Run: `npm run test -w @wfe/ui -- api-contract.test.ts`
Expected: PASS (this test starts its own Postgres testcontainer via the
file's existing `beforeAll` — allow the full 180s timeout already configured
on that hook).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/test/contract/api-contract.test.ts
git commit -m "test(ui): extend the contract suite to cover create/edit/publish/archive"
```

---

## Task 11: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck every package**

Run: `npm run typecheck -w @wfe/core -w @wfe/server -w @wfe/sdk -w @wfe/ui`
Expected: exits 0.

- [ ] **Step 2: Run every package's test suite**

Run: `npm run test -w @wfe/core -w @wfe/server -w @wfe/ui`
Expected: PASS across all three (core and server use `jest.setTimeout` /
testcontainers for their DB-backed suites, so allow several minutes).

- [ ] **Step 3: Run the drift test one more time**

Run: `npm run test -w @wfe/ui -- schema-freshness.test.ts`
Expected: PASS — confirms nothing after Task 3 touched `buildOpenApiSpec`
without regenerating.

- [ ] **Step 4: Build every package**

Run: `npm run build`
Expected: exits 0 (turbo runs `build` across the workspace, including
`@wfe/ui`'s `tsc --noEmit && vite build`).

- [ ] **Step 5: Manual smoke check (optional but recommended)**

Run: `npm run dev -w @wfe/ui` against a locally running server, and in a
browser: create a definition, add a step with an input, save it, publish it,
confirm the Edit button disappears and Archive appears, archive it, confirm
both controls disappear.

No commit for this task — it only verifies work already committed in Tasks
1–10.
