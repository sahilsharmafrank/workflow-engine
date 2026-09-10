import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataTable } from "../../src/components/DataTable";

interface Row { id: number; name: string; n: number }
const rows: Row[] = [
  { id: 1, name: "beta", n: 2 },
  { id: 2, name: "alpha", n: 10 },
];
const columns = [
  { key: "name", header: "Name", render: (r: Row) => r.name, sortValue: (r: Row) => r.name },
  { key: "n", header: "N", render: (r: Row) => r.n, sortValue: (r: Row) => r.n },
];

describe("DataTable", () => {
  it("renders a row per item", () => {
    render(<DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} emptyMessage="none" />);
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("sorts numerically, not lexically, when a column sorts by number", async () => {
    // 10 vs 2 is where a lexical sort silently does the wrong thing, so this
    // is the case that distinguishes a real comparator from String() coercion.
    render(<DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} emptyMessage="none" />);
    await userEvent.click(screen.getByRole("button", { name: "N" }));
    const cells = screen.getAllByRole("cell").filter((c) => ["2", "10"].includes(c.textContent ?? ""));
    expect(cells.map((c) => c.textContent)).toEqual(["2", "10"]);
  });

  it("shows the empty message when there are no rows", () => {
    render(<DataTable columns={columns} rows={[]} getRowKey={(r) => r.id} emptyMessage="No runs yet" />);
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });

  it("calls onRowClick with the clicked row", async () => {
    const onRowClick = vi.fn();
    render(
      <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} emptyMessage="none" onRowClick={onRowClick} />
    );
    await userEvent.click(screen.getByText("alpha"));
    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
  });
});
