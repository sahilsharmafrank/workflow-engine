import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusPill, statusColor } from "../../src/components/StatusPill";

describe("StatusPill", () => {
  it("renders the status text", () => {
    render(<StatusPill status="complete" />);
    expect(screen.getByText("complete")).toBeInTheDocument();
  });

  it("distinguishes terminal-good, terminal-bad and in-flight statuses", () => {
    // The pill's only job is making three states scannable at a glance. If
    // every status mapped to the same colour the component would still render
    // and a text-only assertion would still pass — so assert the mapping.
    expect(statusColor("complete")).toBe("success");
    expect(statusColor("failed")).toBe("error");
    expect(statusColor("cancelled")).toBe("warning");
    expect(statusColor("running")).toBe("info");
    expect(statusColor("waiting")).toBe("info");
    expect(statusColor("skipped")).toBe("default");
  });

  it("falls back to default for a status it does not know", () => {
    expect(statusColor("something-new")).toBe("default");
  });
});
