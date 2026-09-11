import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StepDefinition } from "@wfe/sdk";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { StepEditor } from "../../src/components/StepEditor";
import type { StepType } from "../../src/api/hooks/useStepTypes";

const stepTypes: StepType[] = [{ type: "core.noop", version: "1.0.0" }, { type: "core.http", version: "1.0.0" }];

function initialStep(): StepDefinition {
  return { stepName: "", stepVersion: "", stepType: "", stepInputs: [] };
}

function Harness({ onChange }: { onChange?: (s: StepDefinition) => void }) {
  const [step, setStep] = useState<StepDefinition>(initialStep());
  return (
    <StepEditor
      index={0}
      step={step}
      stepTypes={stepTypes}
      canMoveUp={false}
      canMoveDown={false}
      onChange={(next) => { setStep(next); onChange?.(next); }}
      onRemove={vi.fn()}
      onMoveUp={vi.fn()}
      onMoveDown={vi.fn()}
    />
  );
}

describe("StepEditor", () => {
  it("edits name, version and step type", async () => {
    // Required MUI TextFields render their label as "Step name *", so an
    // exact getByLabelText("Step name") match fails; { exact: false } does
    // a substring match instead. This is the same "MUI rendering doesn't
    // match a naive query" situation the brief calls out for Autocomplete,
    // just triggered by the `required` asterisk instead.
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Step name", { exact: false }), "Prepare");
    await userEvent.type(screen.getByLabelText("Step version", { exact: false }), "1.0.0");
    await userEvent.type(screen.getByLabelText("Step type", { exact: false }), "core.transform");
    expect(screen.getByLabelText("Step name", { exact: false })).toHaveValue("Prepare");
    expect(screen.getByLabelText("Step version", { exact: false })).toHaveValue("1.0.0");
    expect(screen.getByLabelText("Step type", { exact: false })).toHaveValue("core.transform");
  });

  it("adds an inputs row via the embedded CaptureExpressionList", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Add inputs row" }));
    expect(screen.getByLabelText("Inputs field name 1")).toHaveValue("");
  });

  it("shows the preflight check editor only once its checkbox is checked", async () => {
    render(<Harness />);
    expect(screen.queryByLabelText("Action on failure")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Preflight check" }));
    // The label resolves to the MUI select's display div, not a real
    // <input>/<select> element, so toHaveValue doesn't apply here — matches
    // the pattern PreFlightCheckEditor.test.tsx already uses for this field.
    expect(screen.getByLabelText("Action on failure")).toHaveTextContent("fail");
  });

  it("hiding the preflight check again clears it back to undefined", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Preflight check" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Preflight check" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ preFlightCheck: undefined }));
  });

  it("disables Move up when it is the first step", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Move step 1 up" })).toBeDisabled();
  });
});
