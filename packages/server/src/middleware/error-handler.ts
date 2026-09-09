import { ErrorRequestHandler } from "express";
import { WfeError } from "@wfe/core";
import { createLogger } from "@wfe/core";

const log = createLogger("error-handler");

/**
 * Catches thrown errors and maps them to a JSON envelope.
 * `WfeError` carries its own status code; everything else is 500.
 * Stack traces and internal paths are never exposed — generic message
 * for untyped errors, structured `{ code, message, details? }` for WfeError.
 */
export function errorHandler(): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (err instanceof WfeError) {
      log.warn("Request failed", { code: err.code, status: err.statusCode, message: err.message });
      res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
      return;
    }

    log.error("Unhandled error", { error: (err as Error).message });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  };
}
