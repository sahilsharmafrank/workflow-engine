import { randomUUID } from "crypto";
import { RequestHandler } from "express";

/** Reads or generates `X-Request-Id` and echoes it on the response. */
export function requestIdMiddleware(): RequestHandler {
  return (req, res, next) => {
    const id = (req.headers["x-request-id"] as string) ?? randomUUID();
    req.headers["x-request-id"] = id;
    res.setHeader("x-request-id", id);
    next();
  };
}
