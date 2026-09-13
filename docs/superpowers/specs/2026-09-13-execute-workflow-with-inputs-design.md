# Execute a workflow from the UI, with required inputs — Design

**Status:** approved, ready for an implementation plan

## 1. Purpose

Let an operator start a run of a published workflow definition from the UI,
filling in a form generated from that definition's declared inputs, instead
of hand-crafting a `POST /runs` JSON body. Today the backend can already
start a run (`POST /api/v1/runs` — `packages/server/src/controllers/runs.ts`)
but nothing in the UI calls it, and nothing anywhere records what inputs a
given definition actually needs — a step's `stepInputs` expressions
(e.g. `workflowState.inputs.jobId`) reference run inputs implicitly, with no
declared list an operator (or the UI) can read.

**Done means:** an operator authoring a definition can declare its named,
typed, required/optional inputs; a published definition shows a "Run" button
that opens a form built from that declaration; submitting it starts a run and
required fields can't be left empty — enforced by both the form and the
server, so the guarantee holds even for a caller that bypasses the UI.

## 2. Scope

`WorkflowDefinitionBody` (`packages/sdk/src/types.ts`) gains an optional
`inputSchema: WorkflowInputField[]`, parallel to how each step already
declares its own `stepInputs`/`stepOutputs`. This is additive and optional —
a definition with no `inputSchema` behaves exactly as today (freeform
`inputs`, no required-field enforcement), so every existing definition,
running workflow, and batch job stays valid unchanged.

Out of scope: type-checking a provided value against its declared type
(§3 "presence only"); a step-type-aware schema describing what each step's
`stepInputs` need (a separate, larger gap — the definition editor design's
§10 already flags it and this doc doesn't try to close it); editing
`inputSchema` for a non-DRAFT definition (inherits the existing
DRAFT-only edit rule, `DEFINITION_NOT_EDITABLE`).

## 3. Decisions

| Decision | Choice | Why |
|---|---|---|
| Field types | `string \| number \| boolean \| json` | Covers scalar inputs (the common case, e.g. `jobId`) plus `json` for a nested-object input a sub-workflow step might need |
| Required-input enforcement | Presence only, not type-checked | Matches today's freeform `WorkflowParameters`; type-checking risks rejecting an existing caller (a script, a batch-job row) that predates the schema |
| Enforcement point | Inside `WorkflowManager.startWorkflow`, one call | Covers direct `POST /runs`, sub-workflow steps, and batch-job fan-out from a single call site — no separate check to keep in sync across three start paths |
| Run entry point | Dedicated page `/definitions/:id/run` | Matches the existing pattern of edit being its own route (`/definitions/:id/edit`), rather than a modal, for a form that can grow to several fields |
| Client-side validation | Required-fields-only, mirrors server rule exactly | Same "minimal client validation" stance the definition editor design already established — anything more is a second copy of server logic that can drift |

## 4. Data model

`packages/sdk/src/types.ts`:

```ts
export type WorkflowInputFieldType = "string" | "number" | "boolean" | "json";

export interface WorkflowInputField {
  name: string;
  type: WorkflowInputFieldType;
  required: boolean;
  description?: string;
}

export interface WorkflowDefinitionBody {
  steps: StepDefinition[];
  inputSchema?: WorkflowInputField[];
}
```

`packages/core/src/registry/validate.ts`'s `definitionSchema` gets a matching
optional `inputSchema` array (yup): `name` required non-empty, `type` one of
the enum, `required` boolean, unique `name` across the array (same duplicate
check `validateAgainstRegistry` already does for step names, applied here to
input names).

## 5. Enforcement

New function in `validate.ts`:

```ts
export function validateRunInputs(
  definition: WorkflowDefinitionBody, inputs: WorkflowParameters
): void
```

Loops `definition.inputSchema ?? []`; collects every required field whose
name is absent from `inputs` (not just the first, matching
`DEFINITION_INVALID`'s all-errors-at-once shape); if any are missing, throws
`WfeError("Missing required input(s): …", { statusCode: 400, code:
"RUN_INPUT_MISSING", details: [{ name }, …] })`.

Called from `WorkflowManager.startWorkflow`
(`packages/core/src/engine/workflow-manager.ts:95-96`), right after
`lookupDefinition` resolves the target definition and before the run row is
created — so a rejected start never leaves a half-created run behind, the
same property the existing sub-workflow-depth guard in that method already
protects.

## 6. Author inputSchema in the Definition Editor

New `InputFieldEditor` component (`packages/ui/src/components/`), same
add/remove/reorder list pattern `StepEditor`/`CaptureExpressionList` already
use. A new "Inputs" section in `DefinitionEditor.tsx`, above "Steps": one row
per field — `name` (text), `type` (select: string/number/boolean/json),
`required` (checkbox), `description` (optional text).

State: `const [inputSchema, setInputSchema] = useState<WorkflowInputField[]>([])`,
pre-filled from `existing.data.definition.inputSchema ?? []` on load,
included in the saved body: `{ steps, inputSchema }`. Client-side validation
mirrors the existing `validate()` function's style: non-empty, unique names,
blocking Save inline — everything else (server's yup errors) surfaced
verbatim through `ErrorState`, unchanged pattern.

## 7. Run page

New `packages/ui/src/screens/RunForm.tsx`, route `/definitions/:id/run`.
`DefinitionDetail.tsx` gets a "Run" button, shown only when
`data.status === "published"` (matches `DefinitionRepository.findPublished`,
the only status `WorkflowManager.lookupDefinition` will start a run against
when no `definitionId` is given).

The page loads the definition via the existing `useDefinition(id)` hook,
reads `inputSchema`, and renders one control per field: text field for
`string`, number field for `number`, checkbox for `boolean`, multi-line text
field (JSON) for `json`. Required fields are marked and block Submit
client-side when empty — the same "presence only" rule the server enforces,
so a user can't even submit an incomplete form, but the server check in §5
still exists because the UI is not the only caller.

On submit: assemble the `inputs` object, `JSON.parse` each `json`-typed field
(a parse failure becomes an inline field error, not a server round trip),
call a new `useCreateRun()` mutation, and on success navigate to
`/runs/:runId`. A `RUN_INPUT_MISSING` response (only reachable if the
definition changed between page load and submit) is surfaced through the
existing `ErrorState`.

New hook, `packages/ui/src/api/hooks/useRuns.ts`:

```ts
export function useCreateRun() {
  return useMutation({
    mutationFn: async (
      body: { name: string; version: string; inputs: WorkflowParameters }
    ): Promise<{ runId: number; status: string }> =>
      unwrap(await api.POST("/api/v1/runs", { body })) as { runId: number; status: string },
  });
}
```

`POST /api/v1/runs` already exists and is already declared in
`packages/server/src/openapi/spec.ts` (`createRun`) with a typed request
body — no server route change needed. Its 200/201 responses currently carry
only a `description`, no content schema; this phase adds
`{ runId: integer, status: string }` response schemas to both, following the
existing pattern of tightening under-typed responses (definition editor
design §4/§10). Regenerate `packages/ui/src/api/openapi.json` and
`schema.d.ts` after that change — the drift test
(`packages/ui/test/schema-freshness.test.ts`) fails until it runs.

## 8. File layout

```
packages/sdk/src/types.ts                         modified — WorkflowInputField, inputSchema on WorkflowDefinitionBody
packages/core/src/registry/validate.ts            modified — inputSchema yup shape, validateRunInputs()
packages/core/src/engine/workflow-manager.ts       modified — call validateRunInputs() in startWorkflow()
packages/server/src/openapi/spec.ts               modified — response schema for createRun

packages/ui/src/
  components/InputFieldEditor.tsx                 new — add/remove list of {name, type, required, description}
  screens/DefinitionEditor.tsx                     modified — "Inputs" section, inputSchema state
  screens/DefinitionDetail.tsx                     modified — "Run" button (published only)
  screens/RunForm.tsx                              new — form generated from inputSchema, submits, navigates to run
  api/hooks/useRuns.ts                              modified — useCreateRun()
  routes.tsx                                        modified — add /definitions/:id/run
  api/openapi.json, api/schema.d.ts                 regenerated
```

## 9. Testing

**Core.** `validate.ts` unit tests for `validateRunInputs`: missing required
field(s) rejected (all names listed, not just first), extra/unknown inputs
allowed through, no `inputSchema` is a no-op. `workflow-manager` test:
`startWorkflow` rejects before any run row is created when a required input
is missing — mutation-provable (deleting the call must turn the test red).

**UI component tests (MSW, typed handlers).** `InputFieldEditor` add/remove;
`DefinitionEditor`'s `inputSchema` round-trip (author it, save, reload,
still there); `RunForm` rendering fields per declared type, blocking submit
on an empty required field, and navigating to the new run on success; "Run"
button appearing only when `status === "published"`.

**Contract suite**
(`packages/ui/test/contract/api-contract.test.ts`, real Postgres +
`createApp()`). Extend with: publish a definition carrying an `inputSchema`
with a required field, start a run omitting it and confirm
`400 RUN_INPUT_MISSING`, then start it again with the field present and
confirm the run is created. This is what actually proves enforcement holds
server-side, not just inside one MSW mock.

**The drift test** already covers the `createRun` response-schema change
automatically — it fails until `openapi.json`/`schema.d.ts` are regenerated.

## 10. Out of scope

Type-checking an input's value against its declared type; a per-step-type
input schema (a separate, larger gap noted in §2); drag-and-drop reordering
of input fields (matches the existing steps-list decision — up/down
buttons only); running an unpublished (DRAFT/ARCHIVED) definition from the
UI; re-running with previously-used inputs pre-filled (no run history lookup
in this phase — `RunForm` always starts from an empty form).
