import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Definitions } from "../../src/screens/Definitions";
import { renderWithProviders } from "../renderWithProviders";

describe("Definitions", () => {
  it("lists definitions with name, version and status", async () => {
    renderWithProviders(<Definitions />);
    expect(await screen.findByText("adhoc")).toBeInTheDocument();
    expect(screen.getAllByText("nightly")).toHaveLength(2);
    expect(screen.getByText("draft")).toBeInTheDocument();
  });

  it("filters by status through the server", async () => {
    renderWithProviders(<Definitions />);
    await screen.findByText("adhoc");
    await userEvent.click(screen.getByLabelText("status"));
    await userEvent.click(screen.getByRole("option", { name: "draft" }));
    // Only the 2.0.0 draft survives — the MSW handler does the filtering, so
    // this fails unless the parameter really reaches the request.
    await waitFor(() => expect(screen.queryByText("adhoc")).not.toBeInTheDocument());
    expect(screen.getAllByText("nightly")).toHaveLength(1);
  });

  it("imports an uploaded JSON file and reports how many landed", async () => {
    renderWithProviders(<Definitions />);
    await screen.findByText("adhoc");

    const file = new File(
      [JSON.stringify({ name: "imported", version: "1.0.0", status: "published", definition: { steps: [] } })],
      "imported.json",
      { type: "application/json" }
    );
    await userEvent.upload(screen.getByLabelText("Upload definitions"), file);

    expect(await screen.findByText("Imported 1 definition.")).toBeInTheDocument();
  });

  it("shows the server's error when an uploaded file is rejected", async () => {
    renderWithProviders(<Definitions />);
    await screen.findByText("adhoc");

    const file = new File([JSON.stringify({ version: "1.0.0", definition: {} })], "bad.json", {
      type: "application/json",
    });
    await userEvent.upload(screen.getByLabelText("Upload definitions"), file);

    expect(await screen.findByText("name is required")).toBeInTheDocument();
    expect(screen.getByText("DEFINITION_INVALID")).toBeInTheDocument();
  });
});
