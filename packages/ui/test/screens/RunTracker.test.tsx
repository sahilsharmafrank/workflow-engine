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

  // Deliberately a different column ("outputs", not "inputs") and value than
  // the test above. The old MSW handler only ever recognized the literal
  // "inputs.jobId" / "job-42" pair, so a component that hardcoded that
  // filter (ignoring what the operator actually typed) passed every other
  // test in this file. This one only passes if the typed key/value actually
  // reach the request.
  it("searches by a different jsonb path than the other search test", async () => {
    renderWithProviders(<RunTracker />);
    await screen.findByText("adhoc");

    await userEvent.type(screen.getByLabelText("Search key"), "outputs.batchId");
    await userEvent.type(screen.getByLabelText("Search value"), "batch-9");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2)); // header + one match
    expect(within(table).getByText("adhoc")).toBeInTheDocument();
    expect(within(table).queryByText("nightly")).not.toBeInTheDocument();
  });

  // The server rejects a filter key whose column isn't allowlisted (or whose
  // path fails validation) with 400 RUN_SEARCH_INVALID_FILTER_KEY rather than
  // silently matching nothing (run-repository.ts:204-211). RunTracker renders
  // rows=[] whenever a search errors (see RunTracker.tsx), so the DataTable's
  // "No run matches that search." text legitimately co-renders even on the
  // correct path — asserting its absence would be asserting against
  // RunTracker's own (already-correct, out-of-scope) rendering. The real
  // distinguishing signal is an *error alert* actually mounting: MUI's Alert
  // defaults to role="alert", which nothing in the empty-results path ever
  // renders. A component that swallowed the error and fell through to just
  // the empty state — indistinguishable from this one if we only checked for
  // "no adhoc/nightly rows" — produces no such element, so scoping the
  // assertion to within that alert is what tells "surfaced the error" apart
  // from "showed zero rows".
  it("surfaces RUN_SEARCH_INVALID_FILTER_KEY instead of showing empty results", async () => {
    renderWithProviders(<RunTracker />);
    await screen.findByText("adhoc");

    await userEvent.type(screen.getByLabelText("Search key"), "bogus.jobId");
    await userEvent.type(screen.getByLabelText("Search value"), "job-42");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("RUN_SEARCH_INVALID_FILTER_KEY")).toBeInTheDocument();
  });
});
