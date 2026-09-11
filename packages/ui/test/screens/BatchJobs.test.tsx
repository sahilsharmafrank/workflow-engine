import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { BatchJobDetail } from "../../src/screens/BatchJobDetail";
import { BatchJobs } from "../../src/screens/BatchJobs";
import { errorResponse } from "../msw/handlers";
import { mswServer } from "../msw/server";
import { renderWithProviders } from "../renderWithProviders";

describe("BatchJobs", () => {
  it("lists batch jobs with status and total", async () => {
    renderWithProviders(<BatchJobs />);
    expect(await screen.findByText("reprocess-may")).toBeInTheDocument();
    expect(screen.getByText("backfill")).toBeInTheDocument();
    // The title promises status and total are shown, not just names, so both
    // are asserted directly rather than only the rows existing.
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});

function renderDetail(id: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/batch-jobs/:id" element={<BatchJobDetail />} />
    </Routes>,
    { route: `/batch-jobs/${id}` }
  );
}

describe("BatchJobDetail", () => {
  it("shows the three progress counts against the total", async () => {
    renderDetail("1");
    expect(await screen.findByText("reprocess-may")).toBeInTheDocument();
    expect(screen.getByText("1 complete")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("1 running")).toBeInTheDocument();
    expect(screen.getByText("3 total")).toBeInTheDocument();
  });

  it("does not present a derived remaining count", async () => {
    // computeProgress never buckets cancelled runs, so any figure derived by
    // subtracting from totalCount silently misreports a cancelled batch. This
    // test exists to stop someone adding that convenience later.
    renderDetail("1");
    await screen.findByText("reprocess-may");
    expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pending/i)).not.toBeInTheDocument();
  });

  it("links each child run into the run detail screen", async () => {
    renderDetail("1");
    expect(await screen.findByRole("link", { name: "Run 1" })).toHaveAttribute("href", "/runs/1");
    expect(screen.getByRole("link", { name: "Run 3" })).toHaveAttribute("href", "/runs/3");
  });

  it("renders a not-found panel for a missing batch job", async () => {
    renderDetail("999");
    expect(await screen.findByText("Not found")).toBeInTheDocument();
  });

  it("surfaces a 409 from cancel instead of pretending it worked", async () => {
    // The schema declares only 200/404 for this endpoint, but the server
    // really answers 409 BATCH_JOB_NOT_CANCELLABLE for a job already in a
    // terminal state. Overriding the handler here (rather than relying on
    // the base fixture's id-2 case, whose GET returns 404 and so never
    // reaches a cancel button) proves the screen surfaces that undeclared
    // response with its code, not merely that it survived the call.
    mswServer.use(
      http.put("http://localhost/api/v1/batch-jobs/:id/cancel", () =>
        errorResponse(409, "BATCH_JOB_NOT_CANCELLABLE", "Batch job 1 is already running and cannot be cancelled")
      )
    );
    renderDetail("1");
    await screen.findByText("reprocess-may");
    await userEvent.click(screen.getByRole("button", { name: "Cancel batch" }));
    expect(await screen.findByText(/already running and cannot be cancelled/)).toBeInTheDocument();
    expect(screen.getByText("BATCH_JOB_NOT_CANCELLABLE")).toBeInTheDocument();
  });
});
