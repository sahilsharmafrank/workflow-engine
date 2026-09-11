import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { RunDetail } from "../../src/screens/RunDetail";
import { errorResponse } from "../msw/handlers";
import { mswServer } from "../msw/server";
import { renderWithProviders } from "../renderWithProviders";

function renderAt(id: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/runs/:id" element={<RunDetail />} />
    </Routes>,
    { route: `/runs/${id}` }
  );
}

describe("RunDetail", () => {
  it("shows every step with its status and failure message", async () => {
    renderAt("2");
    expect(await screen.findByText("Prepare")).toBeInTheDocument();
    expect(screen.getByText("Call")).toBeInTheDocument();
    // The failure message is the reason an operator opened this screen.
    expect(screen.getByText("connect ECONNREFUSED")).toBeInTheDocument();
  });

  it("renders a not-found panel for a missing run", async () => {
    renderAt("999");
    expect(await screen.findByText("Not found")).toBeInTheDocument();
  });

  it("surfaces a 409 from cancel instead of pretending it worked", async () => {
    renderAt("2");
    await screen.findByText("Prepare");
    await userEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    // A terminal run genuinely cannot be cancelled; showing the server's
    // answer is the behaviour under test. Asserting only "no crash" would
    // pass against a screen that swallowed the error entirely.
    expect(await screen.findByText(/already failed and cannot be cancelled/)).toBeInTheDocument();
    expect(screen.getByText("RUN_NOT_CANCELLABLE")).toBeInTheDocument();
  });

  it("restarts from a chosen step", async () => {
    renderAt("2");
    await screen.findByText("Call");
    // Only the failed step is expanded by default, so MUI's Collapse leaves
    // the "Prepare" panel's contents at visibility:hidden — invisible to an
    // accessibility-tree query even though the DOM node exists. Expanding it
    // first is what makes index [1] below actually resolve to the "Call"
    // step's button instead of `undefined` (a no-op click that a passing
    // assertion could not have told apart from a real one).
    await userEvent.click(screen.getByText("Prepare"));
    await userEvent.click(screen.getAllByRole("button", { name: "Restart from here" })[1]);
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument());
  });

  it("links to the parent run when parentRunId is set", async () => {
    renderAt("5");
    await screen.findByText("Sub-step");
    // The link is the only way an operator follows sub-workflow lineage
    // (Phase 4's parentRunId/depth), so both its presence and its target
    // matter — a link to the wrong run would be as useless as no link.
    const link = screen.getByRole("link", { name: "run 2" });
    expect(link).toHaveAttribute("href", "/runs/2");
  });

  it("renders no parent link for a run without one", async () => {
    renderAt("2");
    await screen.findByText("Prepare");
    // A block that always renders would pass a positive-only test while
    // showing "Child of run null" on every ordinary run.
    expect(screen.queryByText(/Child of/)).not.toBeInTheDocument();
  });

  it("surfaces a failed restart instead of leaving the operator guessing", async () => {
    mswServer.use(
      http.put("http://localhost/api/v1/runs/:id/restart/step/:n", () =>
        errorResponse(500, "STEP_RESTART_FAILED", "Restart could not be scheduled")
      )
    );
    renderAt("2");
    await screen.findByText("Call");
    await userEvent.click(screen.getByText("Prepare"));
    await userEvent.click(screen.getAllByRole("button", { name: "Restart from here" })[1]);
    // Restart resets the chosen step and everything after it; an operator
    // who triggers it needs to know whether it failed, not see nothing
    // happen and assume it's still in flight.
    expect(await screen.findByText("Restart could not be scheduled")).toBeInTheDocument();
    expect(screen.getByText("STEP_RESTART_FAILED")).toBeInTheDocument();
  });
});
