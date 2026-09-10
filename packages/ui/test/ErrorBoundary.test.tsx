import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/AppShell";

function Boom(): never {
  throw new Error("kaboom");
}

describe("AppShell's ErrorBoundary", () => {
  it("catches a rendering error in the routed content and shows the fallback instead of crashing the whole page", () => {
    // React (and our own componentDidCatch) both log to console.error when
    // a boundary catches — silence it the way the rest of the suite would,
    // but still assert on it below to prove the boundary actually reported.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const router = createMemoryRouter([{ path: "/", element: <AppShell />, children: [{ index: true, element: <Boom /> }] }], {
      initialEntries: ["/"],
    });

    render(<RouterProvider router={router} />);

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("kaboom")).toBeInTheDocument();
    // The nav shell itself must survive — only the routed content should be
    // swapped for the fallback.
    expect(screen.getByRole("link", { name: "Runs" })).toBeInTheDocument();

    expect(consoleError).toHaveBeenCalledWith("UI crashed", expect.any(Error), expect.anything());

    consoleError.mockRestore();
  });
});
