import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { routes } from "../src/routes";

// The "/runs" route renders RunTracker, which calls TanStack Query hooks —
// so this needs a QueryClientProvider even though the test itself only
// asserts on the nav chrome. Without one, RunTracker throws ("No QueryClient
// set"), AppShell's ErrorBoundary catches it, and the suite stays green
// while dumping a big stack trace to stderr on every run — exactly the kind
// of noise this project treats as a missed warning waiting to happen.
// createMemoryRouter/RouterProvider (a data router), not the plain
// MemoryRouter test/renderWithProviders.tsx wraps with, since this suite
// needs the actual `routes` tree (nav + nested children) to exercise
// highlighting and the index redirect.
function renderApp(initialEntries: string[]) {
  const router = createMemoryRouter(routes, { initialEntries });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return router;
}

describe("AppShell", () => {
  it("renders every nav destination and marks the active one selected", () => {
    renderApp(["/runs"]);

    for (const label of ["Runs", "Definitions", "Batch jobs", "Step catalog"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    // Selection is what tells an operator where they are; asserting only that
    // the links exist would pass against a nav that never highlights anything.
    expect(screen.getByRole("link", { name: "Runs" })).toHaveClass("Mui-selected");
  });

  it("redirects the index route to /runs", () => {
    const router = renderApp(["/"]);
    expect(router.state.location.pathname).toBe("/runs");
  });
});
