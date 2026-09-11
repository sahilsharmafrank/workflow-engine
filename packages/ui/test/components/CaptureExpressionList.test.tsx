import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CaptureExpressionList } from "../../src/components/CaptureExpressionList";

describe("CaptureExpressionList", () => {
  it("renders a row per entry with its field name and expression", () => {
    render(
      <CaptureExpressionList
        label="Inputs"
        value={[{ targetFieldName: "jobId", modelEvaluationExpression: "$.input.jobId" }]}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Inputs field name 1")).toHaveValue("jobId");
    expect(screen.getByLabelText("Inputs expression 1")).toHaveValue("$.input.jobId");
  });

  it("adds a blank row on Add", async () => {
    const onChange = vi.fn();
    render(<CaptureExpressionList label="Inputs" value={[]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add inputs row" }));
    expect(onChange).toHaveBeenCalledWith([{ targetFieldName: "", modelEvaluationExpression: "" }]);
  });

  it("removes a row without disturbing the others", async () => {
    const onChange = vi.fn();
    const value = [
      { targetFieldName: "a", modelEvaluationExpression: "1" },
      { targetFieldName: "b", modelEvaluationExpression: "2" },
    ];
    render(<CaptureExpressionList label="Inputs" value={value} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Remove Inputs row 1"));
    expect(onChange).toHaveBeenCalledWith([{ targetFieldName: "b", modelEvaluationExpression: "2" }]);
  });

  it("edits a field in place without disturbing other rows", async () => {
    const onChange = vi.fn();
    const value = [{ targetFieldName: "a", modelEvaluationExpression: "1" }];
    render(<CaptureExpressionList label="Inputs" value={value} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Inputs field name 1"), "x");
    expect(onChange).toHaveBeenLastCalledWith([{ targetFieldName: "ax", modelEvaluationExpression: "1" }]);
  });
});
