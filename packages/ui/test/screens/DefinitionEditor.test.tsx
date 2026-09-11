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
    // "Name" and "Version" are required MUI TextFields, so their rendered
    // label carries an appended " *" (see StepEditor.test.tsx's precedent
    // for "Step name"/"Step version"/"Step type") — exact match fails. A
    // plain `{ exact: false }` substring match is too broad here though:
    // "Name" is also a substring of "Step name" and "Inputs field name 1",
    // so an anchored regex (`/^Name\b/`) is used instead to match only the
    // field whose label actually starts with that word.
    await userEvent.type(screen.getByLabelText(/^Name\b/), "wf");
    await userEvent.type(screen.getByLabelText(/^Version\b/), "1.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getByLabelText(/^Step name\b/), "Only");
    await userEvent.type(screen.getByLabelText(/^Step version\b/), "1.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("At least one input is required.")).toBeInTheDocument();
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
});
