import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client";
import {
  useCreateDefinition, usePublishDefinition, useUpdateDefinition,
} from "../../src/api/hooks/useDefinitions";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("definition mutation hooks", () => {
  it("creates a definition", async () => {
    const { result } = renderHook(() => useCreateDefinition(), { wrapper });
    result.current.mutate({ name: "new-wf", version: "1.0.0", definition: { steps: [] } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.name).toBe("new-wf");
    expect(result.current.data?.status).toBe("draft");
  });

  it("updates a draft definition", async () => {
    const { result } = renderHook(() => useUpdateDefinition(), { wrapper });
    result.current.mutate({ id: 2, version: "2.0.1", definition: { steps: [] } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.version).toBe("2.0.1");
  });

  it("surfaces DEFINITION_NOT_EDITABLE when updating a published definition", async () => {
    const { result } = renderHook(() => useUpdateDefinition(), { wrapper });
    result.current.mutate({ id: 1, version: "1.0.1", definition: { steps: [] } });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe("DEFINITION_NOT_EDITABLE");
  });

  it("publishes a draft definition", async () => {
    const { result } = renderHook(() => usePublishDefinition(), { wrapper });
    result.current.mutate(2);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe("published");
  });
});
