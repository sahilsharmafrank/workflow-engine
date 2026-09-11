import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreFlightCheckActionOutcome } from "@wfe/sdk";
import { describe, expect, it, vi } from "vitest";
import { PreFlightCheckEditor } from "../../src/components/PreFlightCheckEditor";

describe("PreFlightCheckEditor", () => {
  it("renders the given conditions, action and message", () => {
    const value = {
      conditionsToCheck: [{ targetFieldName: "x", modelEvaluationExpression: "$.state.x" }],
      actionOnFailure: PreFlightCheckActionOutcome.SKIP,
      failureMessage: "skip when x set",
    };
    render(<PreFlightCheckEditor value={value} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Conditions to check field name 1")).toHaveValue("x");
    expect(screen.getByLabelText("Action on failure")).toHaveTextContent("skip");
    expect(screen.getByLabelText("Failure message")).toHaveValue("skip when x set");
  });

  it("defaults to an empty condition list and a fail action when value is undefined", () => {
    render(<PreFlightCheckEditor value={undefined} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Action on failure")).toHaveTextContent("fail");
    expect(screen.queryByLabelText(/Conditions to check field name/)).not.toBeInTheDocument();
  });

  it("propagates a condition-list edit merged with the rest of the check", async () => {
    const onChange = vi.fn();
    const value = {
      conditionsToCheck: [{ targetFieldName: "x", modelEvaluationExpression: "1" }],
      actionOnFailure: PreFlightCheckActionOutcome.FAIL,
    };
    render(<PreFlightCheckEditor value={value} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add conditions to check row" }));
    expect(onChange).toHaveBeenCalledWith({
      ...value,
      conditionsToCheck: [...value.conditionsToCheck, { targetFieldName: "", modelEvaluationExpression: "" }],
    });
  });
});
