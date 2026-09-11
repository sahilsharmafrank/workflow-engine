import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DefinitionDetail } from "../../src/screens/DefinitionDetail";
import { renderWithProviders } from "../renderWithProviders";

function renderAt(id: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/definitions/:id" element={<DefinitionDetail />} />
    </Routes>,
    { route: `/definitions/${id}` }
  );
}

describe("DefinitionDetail", () => {
  it("shows the definition and its other versions, filtered by name through the server", async () => {
    renderAt("1");
    expect(await screen.findByText("nightly 1.0.0")).toBeInTheDocument();
    expect(await screen.findByText("2.0.0")).toBeInTheDocument();

    // "Versions" is GET /definitions?name=nightly under the hood (the same
    // list hook, filtered server-side — no dedicated endpoint). The history
    // columns don't render a definition's name, so counting rows is what
    // actually distinguishes "the request carried name=nightly" from "the
    // screen rendered every definition regardless": three fixtures exist in
    // total, but only the two nightly ones (this one plus its 2.0.0 sibling)
    // should come back — 1 header row + 2 body rows. Without the filter
    // reaching the server, the unrelated "adhoc" definition would add a
    // fourth row here even though nothing prints its name to catch directly.
    expect(await screen.findAllByRole("row")).toHaveLength(3);
  });

  it("renders a not-found panel for a missing definition", async () => {
    renderAt("999");
    expect(await screen.findByText("Not found")).toBeInTheDocument();
  });
});
