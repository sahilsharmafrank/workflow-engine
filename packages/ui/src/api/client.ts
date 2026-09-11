// src/api/client.ts — completed in Task 3
import createClient from "openapi-fetch";
import type { paths } from "./schema";

export interface ApiErrorDetail {
  path?: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorDetail[]
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// R1: the generated schema's path keys already carry the /api/v1 prefix
// (e.g. "/api/v1/step-types"), so the base URL is empty and every call site
// uses the full prefixed path literal. A non-empty "/api/v1" base would
// double the prefix.
export const api = createClient<paths>({ baseUrl: "" });

interface ServerErrorBody {
  error?: { code?: string; message?: string; details?: ApiErrorDetail[] };
}

/**
 * Every server error is `{ error: { code, message, details? } }`, so this is
 * the single place that shape is parsed. Screens receive an ApiError
 * carrying the code (and, when the server sent one, the per-field details
 * list) and never touch a response body.
 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    const body = result.error as ServerErrorBody | undefined;
    throw new ApiError(
      result.response.status,
      body?.error?.code ?? "UNKNOWN",
      body?.error?.message ?? `Request failed with status ${result.response.status}`,
      body?.error?.details
    );
  }
  return result.data as T;
}
