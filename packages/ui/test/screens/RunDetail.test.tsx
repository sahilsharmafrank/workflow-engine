import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { RunDetail } from "../../src/screens/RunDetail";
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
});
