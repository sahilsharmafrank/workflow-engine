# Execute a Workflow from the UI, with Required Inputs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator declare a workflow definition's named/typed/required inputs, then run a published definition from a UI form generated from that declaration.

**Architecture:** `WorkflowDefinitionBody` gains an optional `inputSchema: WorkflowInputField[]`. A new `validateRunInputs()` in core checks required-field presence and is called once, inside `WorkflowManager.startWorkflow`, so every start path (direct API, sub-workflow, batch-job fan-out) is covered by one call site. The UI adds an "Inputs" section to the existing `DefinitionEditor`, a "Run" button on `DefinitionDetail` (published only), and a new `RunForm` screen that renders one control per declared field, blocks submission on an empty required field, and posts to the already-existing `POST /runs` endpoint.

**Tech Stack:** TypeScript, yup (core validation), Express (server), React + MUI + TanStack Query (UI), Jest (core/server tests), Vitest + Testing Library + MSW (UI tests), Testcontainers Postgres (integration/contract tests).

**Spec:** `docs/superpowers/specs/2026-09-13-execute-workflow-with-inputs-design.md`

## Global Constraints

- `inputSchema` is **optional** on `WorkflowDefinitionBody` — a definition with none behaves exactly as today (spec §2).
- Required-input enforcement is **presence only** — no type-checking of the provided value (spec §3, §5).
- Enforcement lives in exactly **one place**: `WorkflowManager.startWorkflow` (spec §5).
- Field types are exactly `"string" | "number" | "boolean" | "json"` (spec §3, §4).
- "Run" is only offered for a `published` definition (spec §3, §7).
- No client-side type-checking beyond required-field presence; anything else server-side, surfaced verbatim (spec §3, §7 — same "minimal client validation" stance as the definition editor).

---

### Task 1: `WorkflowInputField` type + core schema validation

**Files:**
- Modify: `packages/sdk/src/types.ts:5-37`
- Modify: `packages/core/src/registry/validate.ts`
- Test: `packages/core/test/registry/validate.test.ts`

**Interfaces:**
- Produces: `WorkflowInputFieldType` (`"string" | "number" | "boolean" | "json"`), `WorkflowInputField { name: string; type: WorkflowInputFieldType; required: boolean; description?: string }`, both exported from `@wfe/sdk`. `WorkflowDefinitionBody.inputSchema?: WorkflowInputField[]`.
- Produces: `validateRunInputs(definition: WorkflowDefinitionBody, inputs: WorkflowParameters): void`, exported from `@wfe/core` (via the existing `export * from "./registry/validate"` in `packages/core/src/index.ts:20` — no change needed there).
- Consumes: nothing new (only existing `WfeError`, yup).

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/registry/validate.test.ts` (new `describe` block at the end of the file):

```ts
import { validateRunInputs } from "../../src/registry/validate";

describe("input schema shape validation", () => {
  it("accepts a definition whose inputSchema declares valid fields", async () => {
    const body = {
      steps: [{ stepName: "A", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
      inputSchema: [
        { name: "jobId", type: "string", required: true },
        { name: "dryRun", type: "boolean", required: false, description: "Skip side effects" },
      ],
    };
    await expect(validateDefinitionShape(body)).resolves.toMatchObject({
      inputSchema: [
        { name: "jobId", type: "string", required: true },
        { name: "dryRun", type: "boolean", required: false },
      ],
    });
  });

  it("rejects an inputSchema field with an unknown type", async () => {
    const body = {
      steps: [{ stepName: "A", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
      inputSchema: [{ name: "jobId", type: "uuid", required: true }],
    };
    await expect(validateDefinitionShape(body)).rejects.toThrow();
  });

  it("rejects an inputSchema field missing its name", async () => {
    const body = {
      steps: [{ stepName: "A", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
      inputSchema: [{ type: "string", required: true }],
    };
    await expect(validateDefinitionShape(body)).rejects.toThrow();
  });

  it("accepts a definition with no inputSchema at all", async () => {
    const body = {
      steps: [{ stepName: "A", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
    };
    const parsed = await validateDefinitionShape(body);
    expect(parsed.inputSchema).toBeUndefined();
  });
});

describe("validateRunInputs", () => {
  const withSchema = {
    steps: [],
    inputSchema: [
      { name: "jobId", type: "string" as const, required: true },
      { name: "note", type: "string" as const, required: false },
    ],
  };

  it("does nothing when every required field is present", () => {
    expect(() => validateRunInputs(withSchema, { jobId: "j-1" })).not.toThrow();
  });

  it("allows extra inputs not named in the schema", () => {
    expect(() => validateRunInputs(withSchema, { jobId: "j-1", extra: 42 })).not.toThrow();
  });

  it("throws a WfeError listing every missing required field", () => {
    const twoRequired = {
      steps: [],
      inputSchema: [
        { name: "jobId", type: "string" as const, required: true },
        { name: "region", type: "string" as const, required: true },
      ],
    };
    try {
      validateRunInputs(twoRequired, {});
      fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WfeError);
      const wfeErr = err as WfeError;
      expect(wfeErr.statusCode).toBe(400);
      expect(wfeErr.code).toBe("RUN_INPUT_MISSING");
      expect(wfeErr.details).toEqual([{ name: "jobId" }, { name: "region" }]);
    }
  });

  it("is a no-op when the definition declares no inputSchema", () => {
    expect(() => validateRunInputs({ steps: [] }, {})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @wfe/core -- -t "input schema shape validation|validateRunInputs"`
Expected: FAIL — `validateRunInputs` is not exported, and `inputSchema` is stripped/rejected by the current yup shape.

- [ ] **Step 3: Add the SDK type**

In `packages/sdk/src/types.ts`, right after `ParameterCaptureExpression` (after line 8):

```ts
export type WorkflowInputFieldType = "string" | "number" | "boolean" | "json";

export interface WorkflowInputField {
  name: string;
  type: WorkflowInputFieldType;
  required: boolean;
  description?: string;
}
```

Then change `WorkflowDefinitionBody` (currently lines 35-37):

```ts
export interface WorkflowDefinitionBody {
  steps: StepDefinition[];
  inputSchema?: WorkflowInputField[];
}
```

- [ ] **Step 4: Add the yup shape and `validateRunInputs` in core**

In `packages/core/src/registry/validate.ts`, change the import on line 1 to also bring in `boolean`:

```ts
import { PreFlightCheckActionOutcome, WorkflowDefinitionBody, WorkflowParameters, resolveStepType } from "@wfe/sdk";
import { array, boolean, mixed, object, string, ValidationError } from "yup";
```

Add a new schema above `definitionSchema` (after the `stepSchema` block, before line 30):

```ts
const inputFieldSchema = object({
  name: string().min(1).required(),
  type: mixed<"string" | "number" | "boolean" | "json">()
    .oneOf(["string", "number", "boolean", "json"])
    .required(),
  required: boolean().required(),
  description: string().optional(),
});
```

Change `definitionSchema` (currently lines 30-32) to:

```ts
const definitionSchema = object({
  steps: array().of(stepSchema).min(1).required(),
  inputSchema: array().of(inputFieldSchema).optional(),
});
```

Add `validateRunInputs` at the end of the file (after `validateAgainstRegistry`):

```ts
/**
 * Rejects a run start that omits a required input declared in the
 * definition's inputSchema. Presence-only: a provided value's type is never
 * checked against the declared type (design doc §3, §5).
 */
export function validateRunInputs(
  definition: WorkflowDefinitionBody, inputs: WorkflowParameters
): void {
  const missing = (definition.inputSchema ?? [])
    .filter((field) => field.required && !(field.name in inputs))
    .map((field) => ({ name: field.name }));

  if (missing.length > 0) {
    throw new WfeError(
      `Missing required input(s): ${missing.map((m) => m.name).join(", ")}`,
      { statusCode: 400, code: "RUN_INPUT_MISSING", details: missing }
    );
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w @wfe/core -- -t "input schema shape validation|validateRunInputs"`
Expected: PASS

- [ ] **Step 6: Run the full core suite's registry tests to check nothing else broke**

Run: `npm run test -w @wfe/core -- validate.test.ts`
Expected: PASS (all prior tests in the file still pass — `inputSchema` is additive/optional)

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/types.ts packages/core/src/registry/validate.ts packages/core/test/registry/validate.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add optional inputSchema to WorkflowDefinitionBody + validateRunInputs

Claude-Session: https://claude.ai/code/session_011BEmqxkUGHStPbmtdmyf5t
EOF
)"
```

---

### Task 2: Wire `validateRunInputs` into `WorkflowManager.startWorkflow`

**Files:**
- Modify: `packages/core/src/engine/workflow-manager.ts:14,95-96`
- Test: `packages/core/test/engine/start-workflow.test.ts`

**Interfaces:**
- Consumes: `validateRunInputs` from Task 1 (`../registry/validate`).
- Produces: nothing new — `WorkflowManager.startWorkflow`'s existing signature is unchanged; it now also throws `WfeError("RUN_INPUT_MISSING")` before creating a run row.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/engine/start-workflow.test.ts`, inside the existing `describe("WorkflowManager.startWorkflow", ...)` block (after the last `it`, before the closing `});`). This needs its own published definition carrying an `inputSchema`, seeded once in `beforeAll` alongside the existing `two-step` one:

```ts
  it("rejects a run that omits a required declared input, without creating a run row", async () => {
    await new DefinitionRepository(db).create({
      tenantId: "default", name: "needs-job-id", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: {
        steps: [{ stepName: "Only", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
        inputSchema: [{ name: "jobId", type: "string", required: true }],
      },
    });

    const before = await runs.list("default", { name: "needs-job-id" });
    await expect(
      manager.startWorkflow({ tenantId: "default", name: "needs-job-id", version: "1.0.0", inputs: {} })
    ).rejects.toMatchObject({ code: "RUN_INPUT_MISSING" });
    const after = await runs.list("default", { name: "needs-job-id" });
    expect(after.total).toBe(before.total);
  });

  it("starts a run when the required declared input is present", async () => {
    const runId = await manager.startWorkflow({
      tenantId: "default", name: "needs-job-id", version: "1.0.0", inputs: { jobId: "j-1" },
    });
    const run = await runs.findById("default", runId);
    expect(run!.inputs).toEqual({ jobId: "j-1" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @wfe/core -- -t "declared input"`
Expected: FAIL — the first new test's `rejects.toMatchObject` fails because `startWorkflow` currently accepts the empty `inputs` and creates a run.

- [ ] **Step 3: Call `validateRunInputs` in `startWorkflow`**

In `packages/core/src/engine/workflow-manager.ts`, change the import on line 14:

```ts
import { validateAgainstRegistry, validateRunInputs } from "../registry/validate";
```

Then, right after `validateAgainstRegistry(definition.definition, this.registry);` (line 96):

```ts
    validateAgainstRegistry(definition.definition, this.registry);
    validateRunInputs(definition.definition, input.inputs);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @wfe/core -- -t "declared input"`
Expected: PASS

- [ ] **Step 5: Run the full start-workflow suite**

Run: `npm run test -w @wfe/core -- start-workflow.test.ts`
Expected: PASS (all tests, including the five pre-existing ones)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/engine/workflow-manager.ts packages/core/test/engine/start-workflow.test.ts
git commit -m "$(cat <<'EOF'
feat(core): enforce required declared inputs when starting a workflow run

Claude-Session: https://claude.ai/code/session_011BEmqxkUGHStPbmtdmyf5t
EOF
)"
```

---

### Task 3: Type `POST /runs`' response and regenerate the UI's generated client

**Files:**
- Modify: `packages/server/src/openapi/spec.ts:145-146`
- Modify (regenerated, not hand-edited): `packages/ui/src/api/openapi.json`, `packages/ui/src/api/schema.d.ts`

**Interfaces:**
- Produces: `POST /api/v1/runs`'s 201/200 responses now carry `{ runId: number, status: string }` in the generated `paths` type — Task 4's `useCreateRun` return-type cast relies on this shape existing (informally; the cast in Task 4 still guards it, per this project's established `unwrap()` pattern).

- [ ] **Step 1: Change the response schema**

In `packages/server/src/openapi/spec.ts`, replace lines 145-146:

```ts
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, version: { type: "string" }, inputs: { type: "object" } }, required: ["name", "version"] } } } },
          responses: { 201: { description: "Run started" }, 200: { description: "Idempotent replay" } },
```

with:

```ts
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, version: { type: "string" }, inputs: { type: "object" } }, required: ["name", "version"] } } } },
          responses: {
            201: { description: "Run started", content: { "application/json": { schema: { type: "object", properties: { runId: { type: "integer" }, status: { type: "string" } }, required: ["runId", "status"] } } } },
            200: { description: "Idempotent replay", content: { "application/json": { schema: { type: "object", properties: { runId: { type: "integer" }, status: { type: "string" } }, required: ["runId", "status"] } } } },
          },
```

- [ ] **Step 2: Confirm the server package still builds**

Run: `npm run build -w @wfe/server`
Expected: succeeds (spec.ts is plain data — this step only guards against a stray syntax error)

- [ ] **Step 3: Regenerate the UI's OpenAPI artifacts**

Run: `npm run generate:api -w @wfe/ui`
Expected: exits 0; `packages/ui/src/api/openapi.json` and `packages/ui/src/api/schema.d.ts` are rewritten, now including a typed `runId`/`status` response for `createRun`.

- [ ] **Step 4: Run the drift test to confirm it's now green**

Run: `npm run test -w @wfe/ui -- schema-freshness.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/openapi/spec.ts packages/ui/src/api/openapi.json packages/ui/src/api/schema.d.ts
git commit -m "$(cat <<'EOF'
feat(server): type POST /runs' response schema; regenerate UI client

Claude-Session: https://claude.ai/code/session_011BEmqxkUGHStPbmtdmyf5t
EOF
)"
```

---

### Task 4: `useCreateRun` hook + MSW handler

**Files:**
- Modify: `packages/ui/src/api/hooks/useRuns.ts`
- Modify: `packages/ui/test/msw/handlers.ts`
- Test: `packages/ui/test/api/useRuns.mutations.test.tsx` (new)

**Interfaces:**
- Consumes: `api`, `unwrap` from `../client` (existing); the regenerated `paths["/api/v1/runs"]["post"]` type from Task 3.
- Produces: `useCreateRun(): UseMutationResult<{ runId: number; status: string }, ApiError, { name: string; version: string; inputs: WorkflowParameters }>` — Task 7's `RunForm` calls this directly.

- [ ] **Step 1: Add a `POST /runs` MSW handler**

In `packages/ui/test/msw/handlers.ts`, add to `runHandlers` (after the existing `http.get(`${BASE}/runs`, ...)` entry, before `http.post(`${BASE}/runs/search`, ...)`):

```ts
  http.post(`${BASE}/runs`, () => HttpResponse.json({ runId: 42, status: "starting" }, { status: 201 })),
```

(This handler is replaced in Task 7 with one that also captures the request body, once a test needs to assert on what was sent — this task's own test only checks the response shape.)

- [ ] **Step 2: Write the failing test**

Create `packages/ui/test/api/useRuns.mutations.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useCreateRun } from "../../src/api/hooks/useRuns";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useCreateRun", () => {
  it("starts a run and returns its runId and status", async () => {
    const { result } = renderHook(() => useCreateRun(), { wrapper });
    result.current.mutate({ name: "nightly", version: "1.0.0", inputs: { jobId: "j-1" } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ runId: 42, status: "starting" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -w @wfe/ui -- useRuns.mutations.test.tsx`
Expected: FAIL — `useCreateRun` is not exported from `useRuns.ts`.

- [ ] **Step 4: Add `useCreateRun`**

In `packages/ui/src/api/hooks/useRuns.ts`, add the import needed for the input type (change the top import line):

```ts
import type { WorkflowParameters } from "@wfe/sdk";
```

Then add, near the other mutations at the end of the file:

```ts
export function useCreateRun() {
  return useMutation({
    mutationFn: async (
      body: { name: string; version: string; inputs: WorkflowParameters }
    ): Promise<{ runId: number; status: string }> =>
      unwrap(await api.POST("/api/v1/runs", { body: body as never })) as { runId: number; status: string },
  });
}
```

(`as never` on the request body mirrors the existing pattern in `useDefinitions.ts`'s `useCreateDefinition`, bridging the same openapi-fetch-generated-type gap, not a real shape mismatch.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w @wfe/ui -- useRuns.mutations.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/api/hooks/useRuns.ts packages/ui/test/msw/handlers.ts packages/ui/test/api/useRuns.mutations.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): add useCreateRun hook for POST /runs

Claude-Session: https://claude.ai/code/session_011BEmqxkUGHStPbmtdmyf5t
EOF
)"
```

---

### Task 5: `InputFieldEditor` component

**Files:**
- Create: `packages/ui/src/components/InputFieldEditor.tsx`
- Test: `packages/ui/test/components/InputFieldEditor.test.tsx` (new)

**Interfaces:**
- Consumes: `WorkflowInputField`, `WorkflowInputFieldType` from `@wfe/sdk` (Task 1).
- Produces: `InputFieldEditor({ value: WorkflowInputField[], onChange: (next: WorkflowInputField[]) => void })` — a default-exportable-free named export, same calling convention as `CaptureExpressionList`. Task 6's `DefinitionEditor` renders it directly.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/test/components/InputFieldEditor.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkflowInputField } from "@wfe/sdk";
import { describe, expect, it, vi } from "vitest";
import { InputFieldEditor } from "../../src/components/InputFieldEditor";

describe("InputFieldEditor", () => {
  it("renders one row per declared field", () => {
    const value: WorkflowInputField[] = [
      { name: "jobId", type: "string", required: true },
      { name: "dryRun", type: "boolean", required: false, description: "Skip side effects" },
    ];
    render(<InputFieldEditor value={value} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Workflow input name 1")).toHaveValue("jobId");
    expect(screen.getByLabelText("Workflow input name 2")).toHaveValue("dryRun");
    expect(screen.getByLabelText("Workflow input description 2")).toHaveValue("Skip side effects");
  });

  it("adds an empty field with type string and required unchecked", async () => {
    const onChange = vi.fn();
    render(<InputFieldEditor value={[]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add workflow input" }));
    expect(onChange).toHaveBeenCalledWith([{ name: "", type: "string", required: false, description: "" }]);
  });

  it("removes a field by row", async () => {
    const onChange = vi.fn();
    const value: WorkflowInputField[] = [
      { name: "jobId", type: "string", required: true },
      { name: "region", type: "string", required: true },
    ];
    render(<InputFieldEditor value={value} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove workflow input row 1" }));
    expect(onChange).toHaveBeenCalledWith([value[1]]);
  });

  it("propagates a name edit merged with the rest of that row", async () => {
    const onChange = vi.fn();
    const value: WorkflowInputField[] = [{ name: "jobId", type: "string", required: true }];
    render(<InputFieldEditor value={value} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Workflow input name 1"), "!");
    expect(onChange).toHaveBeenCalledWith([{ ...value[0], name: "jobId!" }]);
  });

  it("toggles required via the checkbox", async () => {
    const onChange = vi.fn();
    const value: WorkflowInputField[] = [{ name: "jobId", type: "string", required: false }];
    render(<InputFieldEditor value={value} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Workflow input required 1"));
    expect(onChange).toHaveBeenCalledWith([{ ...value[0], required: true }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wfe/ui -- InputFieldEditor.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `InputFieldEditor`**

Create `packages/ui/src/components/InputFieldEditor.tsx`:

```tsx
import { Add, Delete } from "@mui/icons-material";
import {
  Button, Checkbox, FormControlLabel, IconButton, MenuItem, Stack, TextField, Typography,
} from "@mui/material";
import type { WorkflowInputField, WorkflowInputFieldType } from "@wfe/sdk";

interface Props {
  value: WorkflowInputField[];
  onChange: (next: WorkflowInputField[]) => void;
}

const FIELD_TYPES: WorkflowInputFieldType[] = ["string", "number", "boolean", "json"];

/**
 * Add/remove editor for a workflow definition's declared inputSchema
 * (design doc §6) — the run-level counterpart to CaptureExpressionList's
 * per-step capture lists, with its own "Workflow input …" label prefix so
 * the two never collide inside the same rendered form.
 */
export function InputFieldEditor({ value, onChange }: Props) {
  function update<K extends keyof WorkflowInputField>(index: number, field: K, next: WorkflowInputField[K]) {
    onChange(value.map((row, i) => (i === index ? { ...row, [field]: next } : row)));
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...value, { name: "", type: "string", required: false, description: "" }]);
  }

  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">Workflow inputs</Typography>
      {value.map((row, i) => (
        <Stack key={i} direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <TextField
            size="small"
            label={`Workflow input name ${i + 1}`}
            value={row.name}
            onChange={(e) => update(i, "name", e.target.value)}
          />
          <TextField
            size="small"
            select
            label={`Workflow input type ${i + 1}`}
            value={row.type}
            onChange={(e) => update(i, "type", e.target.value as WorkflowInputFieldType)}
            sx={{ minWidth: 120 }}
          >
            {FIELD_TYPES.map((t) => (
              <MenuItem key={t} value={t}>{t}</MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={
              <Checkbox
                aria-label={`Workflow input required ${i + 1}`}
                checked={row.required}
                onChange={(e) => update(i, "required", e.target.checked)}
              />
            }
            label="Required"
          />
          <TextField
            size="small"
            label={`Workflow input description ${i + 1}`}
            value={row.description ?? ""}
            onChange={(e) => update(i, "description", e.target.value)}
            sx={{ flexGrow: 1 }}
          />
          <IconButton aria-label={`Remove workflow input row ${i + 1}`} onClick={() => remove(i)} size="small">
            <Delete fontSize="small" />
          </IconButton>
        </Stack>
      ))}
      <Button size="small" startIcon={<Add />} onClick={add} sx={{ alignSelf: "flex-start" }}>
        Add workflow input
      </Button>
    </Stack>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @wfe/ui -- InputFieldEditor.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/InputFieldEditor.tsx packages/ui/test/components/InputFieldEditor.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): add InputFieldEditor for authoring a definition's inputSchema

Claude-Session: https://claude.ai/code/session_011BEmqxkUGHStPbmtdmyf5t
EOF
)"
```

---

### Task 6: Wire `InputFieldEditor` into `DefinitionEditor`

**Files:**
- Modify: `packages/ui/src/screens/DefinitionEditor.tsx`
- Modify: `packages/ui/test/screens/DefinitionEditor.test.tsx`

**Interfaces:**
- Consumes: `InputFieldEditor` (Task 5), `WorkflowInputField` (Task 1).
- Produces: nothing new for later tasks — `RunForm` (Task 7) reads `inputSchema` off a definition fetched through the existing `useDefinition` hook, unaffected by this task's internals.

- [ ] **Step 1: Write the failing test**

Add to `packages/ui/test/screens/DefinitionEditor.test.tsx` (new `it`s, after the existing "creates a definition..." test):

```tsx
  it("includes an authored inputSchema in the saved definition", async () => {
    renderNew();
    await userEvent.type(screen.getByLabelText(/^Name\b/), "with-inputs");
    await userEvent.type(screen.getByLabelText(/^Version\b/), "1.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getByLabelText(/^Step name\b/), "Only");
    await userEvent.type(screen.getByLabelText(/^Step version\b/), "1.0.0");
    await userEvent.type(screen.getByLabelText(/^Step type\b/), "core.noop");

    await userEvent.click(screen.getByRole("button", { name: "Add workflow input" }));
    await userEvent.type(screen.getByLabelText("Workflow input name 1"), "jobId");
    await userEvent.click(screen.getByLabelText("Workflow input required 1"));

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/navigated to \d+/)).toBeInTheDocument();

    // The JSON preview is the saved body's source of truth (design doc §6/
    // DefinitionEditor's existing pattern) — asserting through it proves the
    // authored inputSchema actually reached the object that gets submitted.
    const preview = screen.getByText(/"inputSchema"/, { selector: "pre" });
    expect(preview.textContent).toContain('"jobId"');
    expect(preview.textContent).toContain('"required": true');
  });

  it("pre-fills inputSchema from an existing draft definition", async () => {
    renderEdit("2");
    expect(await screen.findByLabelText(/^Name\b/)).toHaveValue("nightly");
    expect(screen.getByLabelText("Workflow input name 1")).toHaveValue("jobId");
    expect(screen.getByLabelText("Workflow input required 1")).toBeChecked();
  });
```

This second test needs `definitionDetailFixture2` (fixture for `id: 2`, already used by the existing pre-fill test) to carry an `inputSchema`. Add it in `packages/ui/test/msw/handlers.ts`:

```ts
export const definitionDetailFixture2 = {
  ...definitionFixtures[1],
  definition: {
    steps: [{
      stepName: "Prepare", stepType: "core.transform", stepVersion: "1.0.0",
      stepInputs: [{ targetFieldName: "x", modelEvaluationExpression: "$.input.x" }],
    }],
    inputSchema: [{ name: "jobId", type: "string", required: true }],
  },
};
```

(This replaces the existing `definitionDetailFixture2` declaration in that file — same object, `inputSchema` added to its `definition`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @wfe/ui -- DefinitionEditor.test.tsx`
Expected: FAIL on both new tests — no "Add workflow input" button exists yet, and the prefilled edit has no `inputSchema` rendered.

- [ ] **Step 3: Add the "Inputs" section to `DefinitionEditor`**

In `packages/ui/src/screens/DefinitionEditor.tsx`:

Add the import:

```ts
import type { StepDefinition, WorkflowDefinitionBody, WorkflowInputField } from "@wfe/sdk";
import { InputFieldEditor } from "../components/InputFieldEditor";
```

Add state, right after the existing `steps` state:

```ts
  const [inputSchema, setInputSchema] = useState<WorkflowInputField[]>([]);
```

In the pre-fill block (currently):
```ts
  if (!isCreate && existing.data && !initialized) {
    setName(existing.data.name);
    setVersion(existing.data.version);
    setSteps((existing.data.definition as WorkflowDefinitionBody).steps);
    setInitialized(true);
  }
```
change to also pre-fill `inputSchema`:

```ts
  if (!isCreate && existing.data && !initialized) {
    setName(existing.data.name);
    setVersion(existing.data.version);
    const body = existing.data.definition as WorkflowDefinitionBody;
    setSteps(body.steps);
    setInputSchema(body.inputSchema ?? []);
    setInitialized(true);
  }
```

In `onSave`, change the assembled body:

```ts
    const body: WorkflowDefinitionBody = { steps, inputSchema };
```

Add the "Inputs" section to the JSX, right above the existing `<Typography variant="h6">Steps</Typography>` line:

```tsx
      <Typography variant="h6">Inputs</Typography>
      <InputFieldEditor value={inputSchema} onChange={setInputSchema} />

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @wfe/ui -- DefinitionEditor.test.tsx`
Expected: PASS (all tests in the file, including the two new ones and every pre-existing one)

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/DefinitionEditor.tsx packages/ui/test/screens/DefinitionEditor.test.tsx packages/ui/test/msw/handlers.ts
git commit -m "$(cat <<'EOF'
feat(ui): author a definition's inputSchema from DefinitionEditor

Claude-Session: https://claude.ai/code/session_011BEmqxkUGHStPbmtdmyf5t
EOF
)"
```

---

### Task 7: `RunForm` screen + "Run" button + route

**Files:**
- Create: `packages/ui/src/screens/RunForm.tsx`
- Modify: `packages/ui/src/screens/DefinitionDetail.tsx`
- Modify: `packages/ui/src/routes.tsx`
- Modify: `packages/ui/test/msw/handlers.ts`
- Test: `packages/ui/test/screens/RunForm.test.tsx` (new)
- Test: `packages/ui/test/screens/DefinitionDetail.test.tsx`

**Interfaces:**
- Consumes: `useDefinition` (existing), `useCreateRun` (Task 4), `WorkflowInputField`/`WorkflowParameters` (`@wfe/sdk`).
- Produces: nothing further downstream — this is the feature's terminal screen.

- [ ] **Step 1: Add fixtures and a "Run" button test to `DefinitionDetail.test.tsx`**

In `packages/ui/test/msw/handlers.ts`, add a third published detail fixture carrying an `inputSchema` (published `id: 3`, matching `definitionFixtures[2]` = `"adhoc" 1.0.0 published`), and register it in the lookup map:

```ts
export const definitionDetailFixture3 = {
  ...definitionFixtures[2],
  definition: {
    steps: [{ stepName: "Only", stepType: "core.noop", stepVersion: "1.0.0", stepInputs: [] }],
    inputSchema: [
      { name: "jobId", type: "string", required: true },
      { name: "dryRun", type: "boolean", required: false },
    ],
  },
};
```

Change the `definitionDetailFixtures` map to also include `3: definitionDetailFixture3` (alongside the existing `1`, `2`, `4` entries).

Add to `packages/ui/test/screens/DefinitionDetail.test.tsx`:

```tsx
  it("shows a Run button only for a published definition, linking to the run form", async () => {
    renderAt("3");
    expect(await screen.findByText("adhoc 1.0.0")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Run" })).toHaveAttribute("href", "/definitions/3/run");
  });

  it("hides the Run button for a draft definition", async () => {
    renderAt("2");
    expect(await screen.findByText("nightly 2.0.0")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Run" })).not.toBeInTheDocument();
  });
```

Also add one assertion to the existing `"hides Edit and the status action for an archived definition"` test (`renderAt("4")`): `expect(screen.queryByRole("link", { name: "Run" })).not.toBeInTheDocument();` — an archived definition is not `"published"` either, so Run must stay hidden there too.

- [ ] **Step 2: Write the failing `RunForm` test**

Add a `POST /runs` echo so a test can assert on what was actually sent — replace the generic Task 4 handler in `packages/ui/test/msw/handlers.ts` with one that captures the body:

```ts
export let lastCreateRunRequest: { name: string; version: string; inputs?: Record<string, unknown> } | undefined;

export function resetLastCreateRunRequest() {
  lastCreateRunRequest = undefined;
}
```

and change the Task 4 handler to:

```ts
  http.post(`${BASE}/runs`, async ({ request }) => {
    lastCreateRunRequest = (await request.json()) as typeof lastCreateRunRequest;
    return HttpResponse.json({ runId: 42, status: "starting" }, { status: 201 });
  }),
```

(Update `useRuns.mutations.test.tsx` from Task 4 if needed — it only asserts the response shape, which is unchanged, so no edit should actually be required there.)

Create `packages/ui/test/screens/RunForm.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { RunForm } from "../../src/screens/RunForm";
import { lastCreateRunRequest, resetLastCreateRunRequest } from "../msw/handlers";
import { renderWithProviders } from "../renderWithProviders";

function RunDetailStub() {
  const { id } = useParams();
  return <div>navigated to run {id}</div>;
}

function renderAt(id: string) {
  resetLastCreateRunRequest();
  return renderWithProviders(
    <Routes>
      <Route path="/definitions/:id/run" element={<RunForm />} />
      <Route path="/runs/:id" element={<RunDetailStub />} />
    </Routes>,
    { route: `/definitions/${id}/run` }
  );
}

describe("RunForm", () => {
  it("renders one control per declared input field", async () => {
    renderAt("3");
    expect(await screen.findByLabelText("jobId")).toBeInTheDocument();
    expect(screen.getByLabelText("dryRun")).toBeInTheDocument();
  });

  it("blocks submission and shows an inline error when a required field is empty", async () => {
    renderAt("3");
    await screen.findByLabelText("jobId");
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("jobId is required.")).toBeInTheDocument();
    expect(lastCreateRunRequest).toBeUndefined();
  });

  it("submits the filled inputs and navigates to the new run", async () => {
    renderAt("3");
    await userEvent.type(await screen.findByLabelText("jobId"), "job-1");
    await userEvent.click(screen.getByLabelText("dryRun"));
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("navigated to run 42")).toBeInTheDocument();
    await waitFor(() =>
      expect(lastCreateRunRequest).toEqual({
        name: "adhoc", version: "1.0.0", inputs: { jobId: "job-1", dryRun: true },
      })
    );
  });

  it("renders a definition with no inputSchema as a form with just the Run button", async () => {
    renderAt("1");
    await screen.findByRole("button", { name: "Run" });
    expect(screen.queryByLabelText(/^Workflow input/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("navigated to run 42")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npm run test -w @wfe/ui -- RunForm.test.tsx DefinitionDetail.test.tsx`
Expected: FAIL — `RunForm` doesn't exist, `DefinitionDetail` has no "Run" link, `definitionDetailFixture3` isn't wired into the lookup map yet.

- [ ] **Step 4: Wire fixture 3 into the lookup map**

In `packages/ui/test/msw/handlers.ts`, change the `definitionDetailFixtures` map to:

```ts
const definitionDetailFixtures: Record<
  number,
  { id: number; name: string; version: string; status: string; updatedDate: string; definition: unknown }
> = {
  1: definitionDetailFixture,
  2: definitionDetailFixture2,
  3: definitionDetailFixture3,
  4: definitionDetailFixture4,
};
```

- [ ] **Step 5: Add the "Run" button to `DefinitionDetail`**

In `packages/ui/src/screens/DefinitionDetail.tsx`, add, right after the existing "Edit" button block (which is gated on `data.status === "draft"`):

```tsx
        {data.status === "published" && (
          <Button component={Link} to={`/definitions/${data.id}/run`} variant="contained" size="small">
            Run
          </Button>
        )}
```

- [ ] **Step 6: Create `RunForm`**

Create `packages/ui/src/screens/RunForm.tsx`:

```tsx
import { Alert, Button, Checkbox, CircularProgress, FormControlLabel, Stack, TextField, Typography } from "@mui/material";
import type { WorkflowDefinitionBody, WorkflowInputField, WorkflowParameters } from "@wfe/sdk";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCreateRun } from "../api/hooks/useRuns";
import { ApiError } from "../api/client";
import { useDefinition } from "../api/hooks/useDefinitions";
import { ErrorState, NotFoundState } from "../components/ErrorState";

type FieldValue = string | boolean;

function initialValues(fields: WorkflowInputField[]): Record<string, FieldValue> {
  return Object.fromEntries(fields.map((f) => [f.name, f.type === "boolean" ? false : ""]));
}

/**
 * Presence-only client check mirroring the server's validateRunInputs
 * (design doc §5, §7): a required field is missing only when its value is
 * still the empty string — a boolean field is never "empty" since it always
 * carries true/false.
 */
function validate(fields: WorkflowInputField[], values: Record<string, FieldValue>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.required && field.type !== "boolean" && values[field.name] === "") {
      errors[field.name] = `${field.name} is required.`;
    }
  }
  return errors;
}

function toInputs(fields: WorkflowInputField[], values: Record<string, FieldValue>): WorkflowParameters {
  const inputs: WorkflowParameters = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (raw === "" || raw === undefined) continue;
    if (field.type === "number") inputs[field.name] = Number(raw);
    else if (field.type === "json") inputs[field.name] = JSON.parse(raw as string);
    else inputs[field.name] = raw;
  }
  return inputs;
}

export function RunForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useDefinition(Number(id));
  const createRun = useCreateRun();

  const fields = useMemo(
    () => ((data?.definition as WorkflowDefinitionBody | undefined)?.inputSchema ?? []),
    [data]
  );
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [touched, setTouched] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  if (data && !initialized) {
    setValues(initialValues(fields));
    setInitialized(true);
  }

  const errors = useMemo(() => validate(fields, values), [fields, values]);

  if (isLoading) return <CircularProgress />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundState message={error.message} />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  function set(name: string, next: FieldValue) {
    setValues((prev) => ({ ...prev, [name]: next }));
  }

  function onSubmit() {
    setTouched(true);
    setParseError(null);
    if (Object.keys(errors).length > 0) return;

    let inputs: WorkflowParameters;
    try {
      inputs = toInputs(fields, values);
    } catch {
      setParseError("One or more JSON fields could not be parsed.");
      return;
    }

    createRun.mutate(
      { name: data.name, version: data.version, inputs },
      { onSuccess: (result) => navigate(`/runs/${result.runId}`) }
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Run {data.name} {data.version}</Typography>

      {fields.map((field) => (
        <Stack key={field.name} spacing={0.5}>
          {field.type === "boolean" ? (
            <FormControlLabel
              control={
                <Checkbox
                  checked={Boolean(values[field.name])}
                  onChange={(e) => set(field.name, e.target.checked)}
                />
              }
              label={field.name}
              aria-label={field.name}
            />
          ) : (
            <TextField
              size="small"
              label={field.name}
              required={field.required}
              type={field.type === "number" ? "number" : "text"}
              multiline={field.type === "json"}
              value={values[field.name] ?? ""}
              onChange={(e) => set(field.name, e.target.value)}
              error={touched && Boolean(errors[field.name])}
              helperText={(touched && errors[field.name]) || field.description}
            />
          )}
        </Stack>
      ))}

      {parseError && <Alert severity="error">{parseError}</Alert>}
      {createRun.error && <ErrorState error={createRun.error} />}

      <Button variant="contained" onClick={onSubmit} disabled={createRun.isPending} sx={{ alignSelf: "flex-start" }}>
        Run
      </Button>
    </Stack>
  );
}
```

- [ ] **Step 7: Add the route**

In `packages/ui/src/routes.tsx`, add the import:

```ts
import { RunForm } from "./screens/RunForm";
```

and the route, right after `{ path: "definitions/:id/edit", element: <DefinitionEditor /> },`:

```ts
      { path: "definitions/:id/run", element: <RunForm /> },
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run test -w @wfe/ui -- RunForm.test.tsx DefinitionDetail.test.tsx`
Expected: PASS

- [ ] **Step 9: Run the full UI suite**

Run: `npm run test -w @wfe/ui`
Expected: PASS (nothing else regressed — in particular `useRuns.mutations.test.tsx` from Task 4, whose assertions only touch the response shape and are unaffected by the handler now also capturing the request body)

- [ ] **Step 10: Commit**

```bash
git add packages/ui/src/screens/RunForm.tsx packages/ui/src/screens/DefinitionDetail.tsx packages/ui/src/routes.tsx packages/ui/test/screens/RunForm.test.tsx packages/ui/test/screens/DefinitionDetail.test.tsx packages/ui/test/msw/handlers.ts
git commit -m "$(cat <<'EOF'
feat(ui): add RunForm screen and Run button to execute a published definition

Claude-Session: https://claude.ai/code/session_011BEmqxkUGHStPbmtdmyf5t
EOF
)"
```

---

### Task 8: Contract suite — end-to-end `RUN_INPUT_MISSING`

**Files:**
- Modify: `packages/ui/test/contract/api-contract.test.ts`

**Interfaces:**
- Consumes: the real server/core stack already wired up in this file's `beforeAll` (`executor`, `client`, `defs` — reuse the existing `DefinitionRepository` instance created inline in `beforeAll`, or construct a second one; either works since it's stateless).

- [ ] **Step 1: Write the failing test**

Add to `packages/ui/test/contract/api-contract.test.ts`, as a new `it` inside the existing `describe` block:

```ts
  it("rejects starting a run that omits a required declared input, then accepts it once present", async () => {
    await defs.create({
      tenantId: "default", name: "contract-needs-input", version: "1.0.0",
      status: WorkflowDefinitionStatus.PUBLISHED,
      definition: {
        steps: [{ stepName: "Only", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
        inputSchema: [{ name: "jobId", type: "string", required: true }],
      },
    });

    const rejected = await client.POST("/api/v1/runs", {
      body: { name: "contract-needs-input", version: "1.0.0", inputs: {} } as never,
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.error!.error.code).toBe("RUN_INPUT_MISSING");

    const accepted = await client.POST("/api/v1/runs", {
      body: { name: "contract-needs-input", version: "1.0.0", inputs: { jobId: "j-1" } } as never,
    });
    expect(accepted.response.status).toBe(201);
    expect(accepted.data!.status).toBeDefined();
  });
```

This references `defs` — the file's `beforeAll` currently declares it as a local `const defs = new DefinitionRepository(db);` used only inline (see line 52 in the file as read during planning: `const defs = new DefinitionRepository(db);`). Promote it to a `let defs: DefinitionRepository;` declared alongside the other `let` variables at the top of the `describe` block, assigned in `beforeAll` (`defs = new DefinitionRepository(db);`), so this new test can reach it too.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wfe/ui -- api-contract.test.ts`
Expected: FAIL — before Tasks 1-2 this errors because `inputSchema` wasn't a recognized field; after Tasks 1-2 are in place (which they are, by this point in the plan) it should already pass. Run it anyway to confirm the real server path, not just core's own unit tests, exercises this.

- [ ] **Step 3: Run again to confirm it passes**

Run: `npm run test -w @wfe/ui -- api-contract.test.ts`
Expected: PASS (all tests in the file, including every pre-existing one)

- [ ] **Step 4: Commit**

```bash
git add packages/ui/test/contract/api-contract.test.ts
git commit -m "$(cat <<'EOF'
test(contract): cover RUN_INPUT_MISSING end-to-end against a real server

Claude-Session: https://claude.ai/code/session_011BEmqxkUGHStPbmtdmyf5t
EOF
)"
```

---

### Task 9: Full-suite and typecheck sweep

**Files:** none (verification only)

- [ ] **Step 1: Typecheck every touched package**

Run: `npm run typecheck -w @wfe/sdk -w @wfe/core -w @wfe/server -w @wfe/ui`
Expected: no errors

- [ ] **Step 2: Run every test suite**

Run: `npm run test -w @wfe/core -w @wfe/server -w @wfe/ui`
Expected: PASS

- [ ] **Step 3: Full workspace build**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 4: Manual smoke check (optional but recommended)**

Run: `npm run dev -w @wfe/ui` against a locally running server (`npm run dev -w @wfe/server` or equivalent), then in the browser: open a published definition with a declared `inputSchema`, click "Run", submit with a required field empty (confirm the inline error), fill it in, submit, and confirm navigation to the new run's detail page.
