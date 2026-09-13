import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("shows Edit and Publish for a draft definition, and switches to Archive after publishing", async () => {
    renderAt("2");
    expect(await screen.findByText("nightly 2.0.0")).toBeInTheDocument();
    // Not asserted by status text here: the "Versions" history table below
    // includes this definition among its own name-siblings (see the
    // pre-existing test above), so its status renders twice on the page —
    // once in the header pill, once in that row — and a plain getByText
    // would fail on the duplicate. The Edit link and the button's own label
    // are unambiguous stand-ins for "this definition is a draft right now".
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute("href", "/definitions/2/edit");
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
  });

  it("hides Edit and the status action for an archived definition", async () => {
    renderAt("4");
    expect(await screen.findByText("legacy 1.0.0")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Run" })).not.toBeInTheDocument();
  });

  it("shows a Run button only for a published definition, linking to the run form", async () => {
    renderAt("3");
    expect(await screen.findByText("adhoc 1.0.0")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Run" })).toHaveAttribute("href", "/definitions/3/run");
  });

  it("hides the Run button for a draft definition", async () => {
    renderAt("2");
    expect(await screen.findByText("nightly 2.0.0")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Run" })).not.toBeInTheDocument();
  });
});
