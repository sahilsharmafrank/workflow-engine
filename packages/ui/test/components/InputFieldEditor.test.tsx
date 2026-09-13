import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkflowInputField } from "@wfe/sdk";
import { describe, expect, it, vi } from "vitest";
import { InputFieldEditor } from "../../src/components/InputFieldEditor";

describe("InputFieldEditor", () => {
  it("renders one row per declared field", () => {
    const value: WorkflowInputField[] = [
      { name: "jobId", type: "string", required: true },
      { name: "dryRun", type: "boolean", required: false, description: "Skip side effects" },
    ];
    render(<InputFieldEditor value={value} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Workflow input name 1")).toHaveValue("jobId");
    expect(screen.getByLabelText("Workflow input name 2")).toHaveValue("dryRun");
    expect(screen.getByLabelText("Workflow input description 2")).toHaveValue("Skip side effects");
  });

  it("adds an empty field with type string and required unchecked", async () => {
    const onChange = vi.fn();
    render(<InputFieldEditor value={[]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add workflow input" }));
    expect(onChange).toHaveBeenCalledWith([{ name: "", type: "string", required: false, description: "" }]);
  });

  it("removes a field by row", async () => {
    const onChange = vi.fn();
    const value: WorkflowInputField[] = [
      { name: "jobId", type: "string", required: true },
      { name: "region", type: "string", required: true },
    ];
    render(<InputFieldEditor value={value} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove workflow input row 1" }));
    expect(onChange).toHaveBeenCalledWith([value[1]]);
  });

  it("propagates a name edit merged with the rest of that row", async () => {
    const onChange = vi.fn();
    const value: WorkflowInputField[] = [{ name: "jobId", type: "string", required: true }];
    render(<InputFieldEditor value={value} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Workflow input name 1"), "!");
    expect(onChange).toHaveBeenCalledWith([{ ...value[0], name: "jobId!" }]);
  });

  it("toggles required via the checkbox", async () => {
    const onChange = vi.fn();
    const value: WorkflowInputField[] = [{ name: "jobId", type: "string", required: false }];
    render(<InputFieldEditor value={value} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Workflow input required 1"));
    expect(onChange).toHaveBeenCalledWith([{ ...value[0], required: true }]);
  });
});
