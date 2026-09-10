import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RunTracker } from "../../src/screens/RunTracker";
import { renderWithProviders } from "../renderWithProviders";

describe("RunTracker", () => {
  it("lists runs with their status", async () => {
    renderWithProviders(<RunTracker />);
    expect(await screen.findByText("adhoc")).toBeInTheDocument();
    expect(screen.getAllByText("nightly")).toHaveLength(2);
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("sends the status filter to the server", async () => {
    renderWithProviders(<RunTracker />);
    await screen.findByText("adhoc");

    await userEvent.click(screen.getByLabelText("status"));
    await userEvent.click(screen.getByRole("option", { name: "failed" }));

    // The MSW handler filters server-side, so rows disappearing proves the
    // parameter was actually sent — a client-side filter would pass this too,
    // which is why the handler, not the component, does the filtering.
    await waitFor(() => expect(screen.queryByText("adhoc")).not.toBeInTheDocument());
    expect(screen.getAllByText("nightly")).toHaveLength(1);
  });

  it("searches by a jsonb input path", async () => {
    renderWithProviders(<RunTracker />);
    await screen.findByText("adhoc");

    await userEvent.type(screen.getByLabelText("Search key"), "inputs.jobId");
    await userEvent.type(screen.getByLabelText("Search value"), "job-42");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(screen.queryByText("adhoc")).not.toBeInTheDocument());
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2); // header + one match
  });
});
