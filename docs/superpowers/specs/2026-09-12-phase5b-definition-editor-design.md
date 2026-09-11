# Phase 5b — the workflow definition editor — Design

**Status:** approved, ready for an implementation plan
**Supersedes for this phase:** the "Phase 5b (definition editor)" line in
`docs/superpowers/specs/2026-09-10-phase5-ui-design.md` §9 (Out of scope) and
§10 (Risks), which deferred this screen without designing it.

## 1. Purpose

Let an operator author and revise workflow definitions through the UI instead
of hand-writing JSON and using `POST /definitions/import`. This is the
write-path screen deliberately deferred from Phase 5 — the only screen that
changes workflow structure, and the reason Phase 5 shipped five read-mostly
screens instead of six.

**Done means:** an operator can create a new draft definition, edit it while
it stays a draft, publish it, and later archive it — entirely through the UI,
with the server (not just the UI) refusing to let a published definition's
body change underneath runs already executing against it.

## 2. Scope

A workflow definition (`WorkflowDefinitionBody`, `packages/sdk/src/types.ts`)
is a **linear ordered array of steps** — there is no DAG and no branching.
`core.condition` (`packages/core/src/steps/condition-step.ts`) skips or fails
the *current* step based on a boolean input; it never jumps to another index.
So this phase is a structured list-of-steps form, not a flow-canvas editor —
substantially smaller than the 491-line original component the spec for
Phase 5 flagged as the reason to split this out.

The backend already exists and works: `POST /definitions` (create),
`PUT /definitions/:id` (update), `POST /definitions/:id/publish`
(status transition), and validation
(`validateDefinitionShape` + `validateAgainstRegistry`,
`packages/core/src/registry/validate.ts`) are all in place from earlier
phases. This phase is the UI on top of that, plus two backend fixes it
surfaced (§4).

## 3. Decisions

| Decision | Choice | Why |
|---|---|---|
| Editable statuses | Create + edit DRAFT only; PUBLISHED/ARCHIVED read-only | A definition's body must not change under runs already executing against its name+version |
| Enforcement | Server-side (`DEFINITION_NOT_EDITABLE`), not just a hidden UI button | A UI-only guard is a convention, not a guarantee — the same class of gap Phase 5's Task 7 review caught once already |
| Form shape | Structured form + read-only JSON preview | One source of truth for what gets submitted; no second editable representation to keep in sync |
| Step type input | Dropdown from `GET /step-types`, free-text fallback | Guards against typos for known types without blocking a type not yet registered; the server is the real validator either way |
| Client-side validation | Required-fields-only; everything else server-side, surfaced verbatim | Mirroring server rules client-side is a second copy that can drift — the exact defect shape repeatedly caught in Phase 5's review |
| Reordering | Up/down buttons, not drag-and-drop | No new dependency for one screen; matches this project's existing YAGNI stance |

## 4. Two backend fixes this phase carries

### `DefinitionRepository.update()` gets a status guard

Today (`packages/core/src/repositories/definition-repository.ts:69-90`)
`update()` performs no status check at all — it will silently overwrite the
`definition` body of a `PUBLISHED` or `ARCHIVED` row, not only a `DRAFT` one.
`publish()` (same file, lines 92-114) already has the lifecycle-transition
pattern to follow (`DRAFT → PUBLISHED → ARCHIVED`, else `400
DEFINITION_LIFECYCLE_INVALID`). Add an equivalent check to `update()`: a
non-DRAFT definition throws `400 DEFINITION_NOT_EDITABLE`. Small, isolated,
core-only change with its own unit test — and the property the contract
suite in §7 depends on to prove the UI's restriction is real, not cosmetic.

### `ApiError` currently drops `details`

The server already emits `{error: {code, message, details}}` for
`DEFINITION_INVALID` — `details` is yup's per-field validation errors as
`[{path, message}]` (`packages/core/src/registry/validate.ts:39-42`,
`packages/server/src/middleware/error-handler.ts:19`). But
`unwrap()`/`ApiError` (`packages/ui/src/api/client.ts`) only reads
`code`/`message` — `details` is silently discarded. Every Phase 5 screen got
away with a flat message because none of them had a document with several
independently-invalid fields; a definition with six steps is the first case
where an operator genuinely needs to know *which* step is wrong. Add an
optional `details` field to `ApiError`, populate it in `unwrap()`, and render
it as a list in `ErrorState` when present. This is a small, generic
infrastructure improvement — not editor-specific — and benefits any future
screen with a multi-field body.

## 5. File layout

```
packages/ui/src/
  screens/
    DefinitionEditor.tsx        new — one screen, used for both create and edit
  components/
    CaptureExpressionList.tsx   new — reusable editor for {targetFieldName, modelEvaluationExpression}[]
    StepEditor.tsx              new — one step's fields; embeds CaptureExpressionList x3 + PreFlightCheckEditor
    PreFlightCheckEditor.tsx    new — conditions list (CaptureExpressionList) + action/message fields
    ErrorState.tsx              modified — render details[] when present
  api/
    client.ts                  modified — ApiError carries details
    hooks/useDefinitions.ts    modified — add useCreateDefinition, useUpdateDefinition, usePublishDefinition
  screens/Definitions.tsx      modified — "New Definition" button, routes to /definitions/new
  screens/DefinitionDetail.tsx modified — "Edit" button (DRAFT only), "Publish"/"Archive" button (dynamic by status, hidden when ARCHIVED)
  routes.tsx                   modified — add /definitions/new, /definitions/:id/edit

packages/server/src/
  openapi (buildOpenApiSpec's Definitions section) — tighten request AND
    response schemas for POST /definitions, PUT /definitions/:id,
    POST /definitions/:id/publish (currently under-typed: bare `object`
    bodies, no response content schemas), and add `details` to the
    ErrorEnvelope schema. Same pattern as Phase 5's Task 4b.
packages/core/src/repositories/definition-repository.ts — status guard in update()
```

Regenerate `packages/ui/src/api/openapi.json` and `schema.d.ts`
(`packages/ui/scripts/generate-api-types.ts`) after the server schema work —
the drift test fails until that runs, which is exactly its job.

## 6. Step editing UI

Each step renders as an expandable card: name, version, type (dropdown
sourced from `GET /step-types`, with a free-text fallback for a type not yet
registered), then three `CaptureExpressionList` instances for
`stepInputs`/`stepOutputs`/`stepStateCapture` (each an add/remove list of
`targetFieldName` + `modelEvaluationExpression` text pairs), then an optional
preflight-check section (`PreFlightCheckEditor`: a `CaptureExpressionList` for
`conditionsToCheck`, plus `actionOnFailure`/`failureMessage` fields). Steps
reorder via up/down buttons and can be added at the end or removed. A JSON
preview panel — the existing read-only `JsonView` component — renders the
assembled document live below the form, so an operator can confirm what will
actually be submitted without a second editable representation existing
anywhere.

`DefinitionEditor` is one component used for both routes:
`/definitions/new` mounts it with empty initial state and calls
`useCreateDefinition` on save; `/definitions/:id/edit` mounts it pre-filled
from `useDefinition(id)` and calls `useUpdateDefinition` — the id's presence
is what distinguishes create from edit, not two separate components.

## 7. Error handling

Required-field violations (empty step name, empty version, zero
`stepInputs`) block the Save button client-side with inline field-level text
— no round trip needed for those, since they can never be different from
what the server would also reject. Everything else —
`DEFINITION_DUPLICATE_STEP_NAME`, `DEFINITION_UNKNOWN_STEP_TYPE`,
`DEFINITION_MISSING_STEP_TYPE`, `DEFINITION_INVALID` (with its `details`
list), `DEFINITION_LIFECYCLE_INVALID`, and the new `DEFINITION_NOT_EDITABLE`
— is a server response surfaced verbatim through the enhanced `ErrorState`.
No client-side reimplementation of any of these rules, consistent with the
"minimal client validation" decision in §3 and this project's standing lesson
that a client-side copy of server validation logic is a defect waiting to
drift out of sync with it.

## 8. Testing

**Component tests (MSW, typed handlers).** `CaptureExpressionList` and
`StepEditor` add/remove/reorder behavior; `DefinitionEditor`'s create flow;
its edit flow pre-filled from an existing DRAFT definition; the "Edit" button
appearing only for DRAFT and the "Publish"/"Archive" label switching by
status on `DefinitionDetail`; `ErrorState` rendering a `details` list. As
with every Phase 5 screen test, each assertion must name a mutation that
would make it fail — a rendered-and-didn't-crash assertion is not a test.

**Core unit test.** `DefinitionRepository.update()`'s new status guard:
mutation-provable — deleting the guard must turn a currently-failing "rejects
updating a published definition" test green.

**Contract suite** (`packages/ui/test/contract/api-contract.test.ts`,
real Postgres + `createApp()`, driven through the generated client). Extend
with: create a definition, edit it while DRAFT, publish it, attempt to edit
again and confirm `409`/`400 DEFINITION_NOT_EDITABLE`, then archive it. This
is the layer that actually proves the DRAFT-only rule holds server-side end
to end — not merely that one MSW mock enforces it.

**The drift test** (existing, `packages/ui/test/schema-freshness.test.ts`)
already covers this phase automatically once the server schema work lands:
it fails until `openapi.json`/`schema.d.ts` are regenerated to match.

## 9. Out of scope

Deleting a definition; drag-and-drop step reordering; a step-type-aware form
that renders different input fields per step type (the registry exposes no
per-type input schema to drive that — see §10); bulk/multi-definition editing
beyond the existing JSON import; editing a definition's `name` (only its body
and `version` are exposed for edit, matching what `update()` already
accepts).

## 10. Risks

**The registry has no per-type input schema.** `StepRegistration`
(`packages/core/src/registry/step-registry.ts`) carries `type`, `version`,
`factory`, and an optional `description` — nothing describing what
`stepInputs` a given type expects. The editor therefore cannot validate or
autocomplete input keys per step type; an operator must know from the step
catalog's description what a type needs. Out of scope to fix here — flagged
so a future phase adding per-type input schemas knows this editor is the
first consumer that would use them.

**`buildOpenApiSpec` is hand-maintained** (carried from Phase 5's own §10).
This phase is the first to exercise it on the write side in earnest; tightening
the three Definitions endpoints (§4) is this phase's contribution to closing
that gap, not a full closure of it — other write routes (e.g. run
cancel/restart, batch-job cancel) remain under-typed per Phase 5's
carry-forward entries.
