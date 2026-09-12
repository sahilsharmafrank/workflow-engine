import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DefinitionEditor } from "../../src/screens/DefinitionEditor";
import { errorResponse } from "../msw/handlers";
import { mswServer } from "../msw/server";
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

  // Regression test for the finding that client-side validation once
  // rejected a step with zero stepInputs — the real server's yup schema
  // (`stepInputs: array().of(captureExpressionSchema).required()`) only
  // rejects undefined/null, not `[]`, and core.noop legitimately needs no
  // inputs at all. A step left with no input rows must therefore save.
  it("saves a step that has no input rows, since the server allows empty stepInputs", async () => {
    renderNew();
    // "Name" and "Version" are required MUI TextFields, so their rendered
    // label carries an appended " *" (see StepEditor.test.tsx's precedent
    // for "Step name"/"Step version"/"Step type") — exact match fails. A
    // plain `{ exact: false }` substring match is too broad here though:
    // "Name" is also a substring of "Step name" and "Inputs field name 1",
    // so an anchored regex (`/^Name\b/`) is used instead to match only the
    // field whose label actually starts with that word.
    await userEvent.type(screen.getByLabelText(/^Name\b/), "no-inputs-wf");
    await userEvent.type(screen.getByLabelText(/^Version\b/), "1.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getByLabelText(/^Step name\b/), "Only");
    await userEvent.type(screen.getByLabelText(/^Step version\b/), "1.0.0");
    await userEvent.type(screen.getByLabelText(/^Step type\b/), "core.noop");
    // Deliberately no "Add inputs row" click — this step keeps stepInputs: [].
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/navigated to \d+/)).toBeInTheDocument();
    expect(screen.queryByText("At least one input is required.")).not.toBeInTheDocument();
  });

  it("creates a definition from a filled-in form and navigates to its detail page", async () => {
    renderNew();
    await userEvent.type(screen.getByLabelText(/^Name\b/), "new-wf");
    await userEvent.type(screen.getByLabelText(/^Version\b/), "1.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getByLabelText(/^Step name\b/), "Only");
    await userEvent.type(screen.getByLabelText(/^Step version\b/), "1.0.0");
    await userEvent.type(screen.getByLabelText(/^Step type\b/), "core.transform");
    await userEvent.click(screen.getByRole("button", { name: "Add inputs row" }));
    await userEvent.type(screen.getByLabelText("Inputs field name 1"), "x");
    await userEvent.type(screen.getByLabelText("Inputs expression 1"), "$.input.x");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/navigated to \d+/)).toBeInTheDocument();
  });

  it("pre-fills from the existing draft definition, with name locked, and saves an edit", async () => {
    renderEdit("2");
    expect(await screen.findByLabelText(/^Name\b/)).toHaveValue("nightly");
    expect(screen.getByLabelText(/^Name\b/)).toBeDisabled();
    expect(screen.getByLabelText(/^Version\b/)).toHaveValue("2.0.0");
    expect(screen.getByLabelText(/^Step name\b/)).toHaveValue("Prepare");
    expect(screen.getByLabelText("Inputs field name 1")).toHaveValue("x");

    await userEvent.clear(screen.getByLabelText(/^Version\b/));
    await userEvent.type(screen.getByLabelText(/^Version\b/), "2.0.1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("navigated to 2")).toBeInTheDocument();
  });

  it("shows a read-only notice instead of the form for a published definition", async () => {
    renderEdit("1");
    expect(await screen.findByText("Only a draft definition can be edited.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Version")).not.toBeInTheDocument();
  });

  // Exercises unwrap()'s body?.error?.details extraction (packages/ui/src/api/client.ts)
  // through a real MSW round trip, and ErrorState's rendering of both the
  // top-level message and the per-field details list — nothing prior to this
  // covered the details path end-to-end. Client-side validation already
  // requires a name, so the only way to reach a DEFINITION_INVALID with
  // details from this screen is a per-test server override, following the
  // same mswServer.use(...) pattern as StepCatalog.test.tsx and RunDetail.test.tsx.
  it("shows the server's message and field-level details from a DEFINITION_INVALID rejection", async () => {
    mswServer.use(
      http.post("http://localhost/api/v1/definitions", () =>
        errorResponse(400, "DEFINITION_INVALID", "Invalid workflow definition", [
          { path: "name", message: "name is a required field" },
        ])
      )
    );
    renderNew();
    await userEvent.type(screen.getByLabelText(/^Name\b/), "wf");
    await userEvent.type(screen.getByLabelText(/^Version\b/), "1.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getByLabelText(/^Step name\b/), "Only");
    await userEvent.type(screen.getByLabelText(/^Step version\b/), "1.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Invalid workflow definition")).toBeInTheDocument();
    expect(screen.getByText(/name is a required field/)).toBeInTheDocument();
  });

  // moveStep/removeStep and the JSON preview (<JsonView value={{ steps }} />)
  // are only ever exercised with a single step elsewhere in this file, so the
  // swap logic and the preview's reflection of it are otherwise untested.
  //
  // StepEditor's "Step name"/"Step version" labels are not namespaced by step
  // index (a known, deliberately-parked gap), so with two steps rendered
  // `getByLabelText` would find two matches — this test scopes with
  // getAllByLabelText(...)[i] instead of relying on unique labels.
  it("reorders steps with the move-up control, updating both the step list and the JSON preview", async () => {
    renderNew();
    await userEvent.type(screen.getByLabelText(/^Name\b/), "wf");
    await userEvent.type(screen.getByLabelText(/^Version\b/), "1.0.0");

    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getAllByLabelText(/^Step name\b/)[0], "First");
    await userEvent.type(screen.getAllByLabelText(/^Step version\b/)[0], "1.0.0");

    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getAllByLabelText(/^Step name\b/)[1], "Second");
    await userEvent.type(screen.getAllByLabelText(/^Step version\b/)[1], "1.0.0");

    // Before the move: the accordion summaries list First, then Second.
    expect(screen.getAllByText(/^(First|Second)$/).map((el) => el.textContent)).toEqual(["First", "Second"]);

    await userEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));

    // After the move: the step list order is visibly swapped...
    expect(screen.getAllByText(/^(First|Second)$/).map((el) => el.textContent)).toEqual(["Second", "First"]);

    // ...and the JSON preview reflects the same new order.
    const preview = screen.getByText(/"stepName"/, { selector: "pre" });
    const previewText = preview.textContent ?? "";
    expect(previewText.indexOf('"Second"')).toBeGreaterThanOrEqual(0);
    expect(previewText.indexOf('"Second"')).toBeLessThan(previewText.indexOf('"First"'));
  });
});
