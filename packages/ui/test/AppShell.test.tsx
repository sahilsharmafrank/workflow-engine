import { render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { routes } from "../src/routes";

describe("AppShell", () => {
  it("renders every nav destination and marks the active one selected", () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/runs"] });
    render(<RouterProvider router={router} />);

    for (const label of ["Runs", "Definitions", "Batch jobs", "Step catalog"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    // Selection is what tells an operator where they are; asserting only that
    // the links exist would pass against a nav that never highlights anything.
    expect(screen.getByRole("link", { name: "Runs" })).toHaveClass("Mui-selected");
  });

  it("redirects the index route to /runs", () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    expect(router.state.location.pathname).toBe("/runs");
  });
});
