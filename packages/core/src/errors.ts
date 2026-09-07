export class WfeError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, opts: { statusCode?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = "WfeError";
    this.statusCode = opts.statusCode ?? 500;
    this.code = opts.code ?? "WFE_ERROR";
    this.details = opts.details;
  }
}
