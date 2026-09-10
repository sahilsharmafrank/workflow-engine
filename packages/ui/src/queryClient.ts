import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api/client";

/**
 * A 4xx is the server's considered answer — a 409 RUN_NOT_CANCELLABLE means
 * the run really is finished — so retrying it just delays showing the user
 * something true. Retry only what might genuinely be transient.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
        staleTime: 5000,
      },
      mutations: { retry: false },
    },
  });
}
