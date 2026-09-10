// src/api/client.ts — completed in Task 3
import createClient from "openapi-fetch";
import type { paths } from "./schema";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// R1: the generated schema's path keys already carry the /api/v1 prefix
// (e.g. "/api/v1/step-types"), so the base URL is empty and every call site
// uses the full prefixed path literal. A non-empty "/api/v1" base would
// double the prefix.
export const api = createClient<paths>({
  baseUrl: "",
  // openapi-fetch's default (`fetch: baseFetch = globalThis.fetch`) reads
  // globalThis.fetch once, as a default-parameter value, at createClient()
  // call time — i.e. at this module's own load time. Under Vitest, the test
  // file's module graph (this module included) finishes loading before any
  // beforeAll hook runs, so MSW's setupServer().listen(), which patches
  // globalThis.fetch to intercept, hasn't run yet when that capture happens.
  // A captured reference then permanently bypasses MSW's patched fetch for
  // every request this client ever makes, and calls fall through to the
  // real network ("TypeError: fetch failed"). Passing this indirection
  // instead defers the globalThis.fetch lookup to each actual call, so it
  // always sees whatever fetch is current — MSW's during tests, the
  // browser's native fetch in production.
  fetch: (request) => globalThis.fetch(request),
});

interface ServerErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * Every server error is `{ error: { code, message } }`, so this is the single
 * place that shape is parsed. Screens receive an ApiError carrying the code and
 * never touch a response body.
 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    const body = result.error as ServerErrorBody | undefined;
    throw new ApiError(
      result.response.status,
      body?.error?.code ?? "UNKNOWN",
      body?.error?.message ?? `Request failed with status ${result.response.status}`
    );
  }
  return result.data as T;
}
