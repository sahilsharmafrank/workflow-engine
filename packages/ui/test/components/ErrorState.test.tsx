import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client";
import { ErrorState } from "../../src/components/ErrorState";

describe("ErrorState", () => {
  it("renders the message and code", () => {
    render(<ErrorState error={new ApiError(400, "DEFINITION_INVALID", "Invalid workflow definition")} />);
    expect(screen.getByText("Invalid workflow definition")).toBeInTheDocument();
    expect(screen.getByText("DEFINITION_INVALID")).toBeInTheDocument();
  });

  it("renders a details list when present", () => {
    render(
      <ErrorState
        error={new ApiError(400, "DEFINITION_INVALID", "Invalid workflow definition", [
          { path: "steps[0].stepName", message: "steps[0].stepName is a required field" },
          { path: "steps[1].stepVersion", message: "steps[1].stepVersion is a required field" },
        ])}
      />
    );
    expect(screen.getByText("steps[0].stepName: steps[0].stepName is a required field")).toBeInTheDocument();
    expect(screen.getByText("steps[1].stepVersion: steps[1].stepVersion is a required field")).toBeInTheDocument();
  });

  it("renders no list when details is absent", () => {
    render(<ErrorState error={new ApiError(404, "DEFINITION_NOT_FOUND", "Definition 9 not found")} />);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("falls back to a generic message for a non-ApiError", () => {
    render(<ErrorState error={new Error("boom")} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});
