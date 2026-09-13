import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { RunForm } from "../../src/screens/RunForm";
import { errorResponse, lastCreateRunRequest, resetLastCreateRunRequest } from "../msw/handlers";
import { mswServer } from "../msw/server";
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
  // "jobId" is a `required` MUI TextField, so its rendered <label> text is
  // actually "jobId *" (MUI appends a required asterisk to the label's own
  // text content, not just visually) — the same mismatch Task 6 hit with
  // DefinitionEditor's required fields. Anchoring with a regex, as that task
  // did, still proves the field is labeled "jobId" without being tripped up
  // by MUI's asterisk suffix.
  it("renders one control per declared input field", async () => {
    renderAt("3");
    expect(await screen.findByLabelText(/^jobId\b/)).toBeInTheDocument();
    expect(screen.getByLabelText("dryRun")).toBeInTheDocument();
  });

  it("blocks submission and shows an inline error when a required field is empty", async () => {
    renderAt("3");
    await screen.findByLabelText(/^jobId\b/);
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("jobId is required.")).toBeInTheDocument();
    expect(lastCreateRunRequest).toBeUndefined();
  });

  it("submits the filled inputs and navigates to the new run", async () => {
    renderAt("3");
    await userEvent.type(await screen.findByLabelText(/^jobId\b/), "job-1");
    await userEvent.click(screen.getByLabelText("dryRun"));
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("navigated to run 42")).toBeInTheDocument();
    await waitFor(() =>
      expect(lastCreateRunRequest).toEqual({
        name: "adhoc", version: "1.0.0", inputs: { jobId: "job-1", dryRun: true },
      })
    );
  });

  it("renders a readable message when the server rejects a missing required input", async () => {
    mswServer.use(
      http.post("http://localhost/api/v1/runs", () =>
        errorResponse(400, "RUN_INPUT_MISSING", "Missing required input(s): jobId", [
          { path: "jobId", message: "jobId is required" },
        ])
      )
    );
    renderAt("3");
    await userEvent.type(await screen.findByLabelText(/^jobId\b/), "job-1");
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Missing required input(s): jobId")).toBeInTheDocument();
    // ErrorState renders `${path}: ` and `message` as sibling text nodes
    // inside one <Typography>, so their joined node text is
    // "jobId: jobId is required" — an exact-match getByText would miss it,
    // so this asserts the substring instead of the whole node text.
    expect(screen.getByText("jobId is required", { exact: false })).toBeInTheDocument();
  });

  it("renders a definition with no inputSchema as a form with just the Run button", async () => {
    renderAt("1");
    await screen.findByRole("button", { name: "Run" });
    expect(screen.queryByLabelText(/^Workflow input/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("navigated to run 42")).toBeInTheDocument();
  });
});
