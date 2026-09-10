import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "../../src/components/FilterBar";
import type { FilterField } from "../../src/api/hooks/useFilterConfiguration";

const fields: FilterField[] = [
  { field: "status", type: "enum", values: ["running", "complete"] },
  { field: "name", type: "text" },
];

describe("FilterBar", () => {
  it("renders a control per descriptor, driven by the server's list", async () => {
    // The values come from /filter-configuration on purpose — a hardcoded
    // status list would drift from the engine. Asserting the options appear
    // proves the descriptors are actually consumed.
    render(<FilterBar fields={fields} value={{}} onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText("status"));
    expect(screen.getByRole("option", { name: "running" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "complete" })).toBeInTheDocument();
  });

  it("reports a changed text filter", async () => {
    const onChange = vi.fn();
    render(<FilterBar fields={fields} value={{}} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("name"), "x");
    expect(onChange).toHaveBeenCalledWith({ name: "x" });
  });
});
