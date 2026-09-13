import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useCreateRun } from "../../src/api/hooks/useRuns";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useCreateRun", () => {
  it("starts a run and returns its runId and status", async () => {
    const { result } = renderHook(() => useCreateRun(), { wrapper });
    result.current.mutate({ name: "nightly", version: "1.0.0", inputs: { jobId: "j-1" } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ runId: 42, status: "starting" });
  });
});
