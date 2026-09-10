import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client";
import { useStepTypes } from "../../src/api/hooks/useStepTypes";
import { errorResponse, stepTypeFixtures } from "../msw/handlers";
import { mswServer } from "../msw/server";
import { http } from "msw";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("api client", () => {
  it("returns typed data on success", async () => {
    const { result } = renderHook(() => useStepTypes(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(stepTypeFixtures);
  });

  it("turns a server error envelope into an ApiError carrying the code", async () => {
    mswServer.use(
      http.get("http://localhost/api/v1/step-types", () =>
        errorResponse(503, "REGISTRY_UNAVAILABLE", "Registry is not ready")
      )
    );

    const { result } = renderHook(() => useStepTypes(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Asserting the code and status, not merely that something threw: the
    // whole point of the mapping is that screens can branch on error.code.
    const error = result.current.error as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(503);
    expect(error.code).toBe("REGISTRY_UNAVAILABLE");
    expect(error.message).toBe("Registry is not ready");
  });
});
