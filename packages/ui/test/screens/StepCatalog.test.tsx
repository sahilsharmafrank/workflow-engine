import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { StepCatalog } from "../../src/screens/StepCatalog";
import { errorResponse } from "../msw/handlers";
import { mswServer } from "../msw/server";
import { renderWithProviders } from "../renderWithProviders";

describe("StepCatalog", () => {
  it("lists the step types the registry reports", async () => {
    renderWithProviders(<StepCatalog />);
    expect(await screen.findByText("core.noop")).toBeInTheDocument();
    expect(screen.getByText("core.http")).toBeInTheDocument();
    expect(screen.getByText("Makes an HTTP request.")).toBeInTheDocument();
  });

  it("filters by the search box", async () => {
    renderWithProviders(<StepCatalog />);
    await screen.findByText("core.noop");
    await userEvent.type(screen.getByLabelText("Search"), "http");
    // core.noop must disappear — asserting only that core.http remains would
    // pass against a search box that does nothing at all.
    await waitFor(() => expect(screen.queryByText("core.noop")).not.toBeInTheDocument());
    expect(screen.getByText("core.http")).toBeInTheDocument();
  });

  it("filters by description text, not just type", async () => {
    renderWithProviders(<StepCatalog />);
    await screen.findByText("core.noop");
    // "immediately" appears only in core.noop's description ("Completes
    // immediately.") and in no step type's type string — this term can only
    // match through the description half of the filter predicate.
    await userEvent.type(screen.getByLabelText("Search"), "immediately");
    await waitFor(() => expect(screen.queryByText("core.http")).not.toBeInTheDocument());
    expect(screen.getByText("core.noop")).toBeInTheDocument();
  });

  it("shows the server's error code when the registry read fails", async () => {
    mswServer.use(
      http.get("http://localhost/api/v1/step-types", () =>
        errorResponse(500, "INTERNAL_ERROR", "boom")
      )
    );
    renderWithProviders(<StepCatalog />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByText("INTERNAL_ERROR")).toBeInTheDocument();
  });
});
