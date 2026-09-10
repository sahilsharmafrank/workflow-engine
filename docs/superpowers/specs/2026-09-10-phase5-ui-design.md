# Phase 5 — `@wfe/ui` observability UI — Design

**Status:** approved, ready for an implementation plan
**Supersedes for this phase:** §11 of `2026-09-07-standalone-workflow-engine-design.md`,
which predates batch jobs and assumed all five screens in one phase.

## 1. Purpose

Give the workflow engine a usable interface for watching what it is doing:
browsing definitions, tracking runs, inspecting a run's steps, watching batch
jobs, and seeing which step types are registered.

Authoring — the definition editor — is deliberately **not** in this phase. It
was the densest screen in the original codebase (491 lines) and it is the only
one that writes workflow structure. It gets its own spec and plan as Phase 5b,
so it receives undivided review attention rather than sharing a cycle with four
read-mostly screens.

**Done means:** `docker compose up` serves a UI at the same origin as the API,
where a person can find a run, see why it failed, restart it from a step, and
cancel a batch job — without `curl`.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Scope | Five read-mostly screens; editor deferred to 5b | The editor is the risk; isolating it protects both halves |
| Stack | Vite, React 18, TypeScript, MUI 5, TanStack Query, React Router | Carried from §11; no CRA (end-of-life) |
| API types | `openapi-typescript` from `buildOpenApiSpec()` | §11 names it; generating from the builder needs no running server |
| API client | `openapi-fetch` | Infers path, method, params and response from the generated types — a wrong route is a compile error |
| Query hooks | Hand-written, thin | ~20 endpoints; a full codegen toolchain would emit more code than it saves |
| Testing | MSW typed from the generated schema, plus a real-stack layer | Mocks alone are this project's known failure mode |
| Serving | `@wfe/server` serves the built assets | Single origin means no CORS, one container, one port |
| Tenancy | None in the UI | `NoneAuthProvider` supplies the tenant; auth is deliberately absent in v1 |

## 3. Package

New workspace `packages/ui`, package name `@wfe/ui`. The root `workspaces`
glob (`packages/*`) already covers it. It carries the same script names as the
other packages — `build`, `test`, `typecheck`, `clean` — so `npm test` and
`turbo run build` pick it up with no root changes.

```
packages/ui/
  index.html
  vite.config.ts          dev proxy: /api -> http://localhost:3000
  src/
    main.tsx              root render, QueryClientProvider, router
    AppShell.tsx          MUI layout, left nav, error boundary
    routes.tsx            route table
    api/
      openapi.json        generated — do not edit
      schema.d.ts         generated — do not edit
      client.ts           openapi-fetch client + ApiError mapping
      hooks/              one file per resource
    components/
      StatusPill.tsx      run/step status vocabulary
      JsonView.tsx        read-only JSON with collapse
      DataTable.tsx       sortable, paginated table
      FilterBar.tsx       renders /filter-configuration descriptors
    screens/
      Definitions.tsx
      DefinitionDetail.tsx
      RunTracker.tsx
      RunDetail.tsx
      BatchJobs.tsx
      BatchJobDetail.tsx
      StepCatalog.tsx
  scripts/generate-api-types.ts
  test/
```

Screens hold layout and data-fetching; anything reusable moves into
`components/`. A screen file growing past a few hundred lines is a signal it is
doing too much and should shed a component.

## 4. The generated client

### Generation

`scripts/generate-api-types.ts`:

1. `const registry = new StepRegistry(); registerBuiltInSteps(registry);`
2. `const spec = buildOpenApiSpec(registry);` — already exported from the
   `@wfe/server` barrel
3. Write `src/api/openapi.json`
4. Run `openapi-typescript` over it into `src/api/schema.d.ts`

No running server, no Docker, deterministic output. Both artefacts are
committed, so a checkout builds without a generation step.

`buildOpenApiSpec` embeds the registered step types, so generation registers
**built-ins only**. Plugin-provided step types are runtime data the UI fetches
from `GET /step-types`; they are not part of the schema.

### The drift guard

A test regenerates both artefacts into a temporary directory and compares them
byte-for-byte with the committed files, failing with an instruction to re-run
the generator. This is the mechanism that makes "the client matches the API" a
checked fact rather than a hope: a server route change that outdates the UI
fails the suite instead of shipping.

### Client

`client.ts` exports a single `createClient<paths>({ baseUrl: "/api/v1" })` and
an `ApiError` carrying the server's `error.code`, `error.message` and the HTTP
status. Every server error already has the shape
`{ error: { code, message } }`, so this mapping lives in one place and no screen
parses an error body.

### Hooks

One file per resource under `api/hooks/`, each a thin TanStack Query wrapper:
`useRuns`, `useRun`, `useDefinitions`, `useDefinition`, `useBatchJobs`,
`useBatchJob`, `useStepTypes`, `useFilterConfiguration`, plus mutations
`useCancelRun`, `useRestartRunFromStep`, `useCancelBatchJob`,
`useImportDefinitions`.

Mutations invalidate the queries they affect. Nothing polls by default; the run
and batch-job detail screens refetch on an interval only while their subject is
in a non-terminal state, and stop once it settles.

## 5. Screens

### Definitions

`GET /definitions` (paginated; `status` and `name` filters) in a `DataTable`:
name, version, status, updated. Selecting a row opens a detail view showing the
definition body via `JsonView`.

Because a definition's identity is name + version, **version history is the
same list filtered by name** — no new endpoint needed.

Upload: a JSON file drop that posts to `POST /definitions/import`, reporting
per-file success and failure. This is the one authoring affordance in the phase;
it is included because it is how definitions get into the system at all, and it
needs no editor.

### Run tracker

`GET /runs` for the default list (`status`, `name`, `limit`, `offset`), and
`POST /runs/search` for jsonb containment queries against `inputs`, `outputs`
and `state`. Columns: id, name, version, status pill, current step, updated.
Filters come from `GET /filter-configuration`.

The search UI must build filter keys of the form `inputs.<path>` — the server
allowlists the column and constrains path segments, rejecting anything else with
`RUN_SEARCH_INVALID_FILTER_KEY`. Surface that message rather than swallowing it.

### Run detail

`GET /runs/:id` returns the run and its steps. Renders a step timeline: number,
name, type, status pill, message, and expandable inputs/outputs/state.

Actions: `PUT /runs/:id/cancel` and `PUT /runs/:id/restart/step/:n`. Both can
legitimately fail — cancel returns 409 `RUN_NOT_CANCELLABLE` on a terminal run —
and the failure is shown as an answer, not retried.

Where a run has `parentRunId` or a non-zero `depth` (added in Phase 4 for
sub-workflows), link to the parent.

### Batch jobs

`GET /batch-jobs` list; `GET /batch-jobs/:id` detail showing the computed
progress (`completedCount`, `failedCount`, `runningCount`) against the total,
and the child runs, each linking into Run detail. `PUT /batch-jobs/:id/cancel`,
which returns 409 `BATCH_JOB_NOT_CANCELLABLE` on a terminal job.

Note `computeProgress` does not currently bucket cancelled runs — a cancelled
batch's counts will not sum to its total. Display the three counts and the
total; do not compute a "remaining" figure that would silently misreport.

### Step catalog

`GET /step-types` — type, version, description — in a searchable table. This is
where an operator confirms a plugin actually loaded, so it reflects the live
registry rather than anything generated.

## 6. Errors and empty states

Every failed request produces an `ApiError`. Screens show a snackbar with the
message plus an inline state; a 404 renders a not-found panel rather than an
error toast. Queries do not retry 4xx responses.

Every table has an explicit empty state distinguishing "nothing exists yet" from
"nothing matches your filter" — the two mean different things to an operator and
the difference is cheap to render.

## 7. Testing

**Component and screen tests** — Vitest with React Testing Library. MSW
intercepts at the network layer, and its handlers are typed from
`schema.d.ts`, so a handler whose shape has drifted from the real contract is a
type error rather than a passing test against fiction.

**Real-stack tests** — a small suite starting a Postgres testcontainer,
building the app with `createApp()`, and driving the *generated client* against
it for the primary reads (runs list, run detail, definitions list, step types,
filter configuration). This is what proves the client and server actually agree;
the MSW layer proves the screens behave.

**The drift test** described in §4.

The project's standing rule applies: a test must be able to fail. For each
screen test, the question is what would have to break for it to go red — a
test that renders a component and asserts it rendered is not a test. This
matters more here than elsewhere, because the entire mock layer is fiction by
construction.

## 8. Serving and deployment

`@wfe/server` serves the built UI as static assets with an SPA fallback so
client-side routes survive a page refresh, mounted so it cannot shadow
`/api/v1`. Same origin, so no CORS middleware is introduced and the product
stays one container on one port.

Development runs Vite with `/api` proxied to `http://localhost:3000`.

The Dockerfile gains a UI build step and copies the built assets into the image.
`docker compose up` then serves API and UI together, which is the milestone for
this phase.

## 9. Out of scope

The definition editor and everything that writes workflow structure (Phase 5b);
authentication and tenant switching (auth is deliberately `none` in v1);
internationalisation; theming beyond MUI's defaults; real-time push — polling
while a subject is non-terminal is sufficient and avoids a websocket surface.

## 10. Risks

**The mock layer is fiction.** Typed handlers and the real-stack suite bound it,
but a screen can still be written against a mock that is type-correct and
behaviourally wrong. The real-stack tests are the check that matters; keep them
covering the primary reads rather than letting them decay into a smoke test.

**`buildOpenApiSpec` is hand-maintained.** The drift test proves the generated
client matches the *document*, not that the document matches the *routes*. A
route whose OpenAPI entry was never written stays invisible to the UI. Phase 3's
review spot-checked this; it is worth a pass when the editor lands and starts
exercising the write routes.

**Vite and MUI are new to this repo.** Their toolchain and the existing
`ts-jest`/turbo setup have to coexist. Vitest is chosen over Jest for the UI
package specifically because it shares Vite's transform pipeline; the other
packages keep Jest.
