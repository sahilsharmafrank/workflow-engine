import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { WfeError } from "../errors";

export class HttpStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    const {
      url,
      method = "GET",
      headers = {},
      body,
      retries = 0,
      backoffMs = 1000,
      timeoutMs = 30000,
    } = ctx.inputs as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      retries?: number;
      backoffMs?: number;
      timeoutMs?: number;
    };

    if (!url) {
      throw new WfeError("core.http requires a url input", {
        statusCode: 400,
        code: "HTTP_STEP_MISSING_URL",
      });
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const fetchHeaders: Record<string, string> = { ...headers };
        if (attempt > 0) {
          fetchHeaders["x-attempt"] = String(attempt + 1);
        }

        const fetchOptions: RequestInit = {
          method: method.toUpperCase(),
          headers: fetchHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        };

        if (body !== undefined && method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") {
          fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
          if (!fetchHeaders["content-type"]) {
            fetchHeaders["content-type"] = "application/json";
          }
        }

        const response = await fetch(url, fetchOptions);

        if (response.ok) {
          let responseBody: unknown;
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            responseBody = await response.json();
          } else {
            responseBody = await response.text();
          }

          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((v, k) => { responseHeaders[k] = v; });

          ctx.step.outputs = { status: response.status, headers: responseHeaders, body: responseBody };
          ctx.step.status = WorkflowStatus.COMPLETE;
          return { stepState: ctx.step };
        }

        lastError = new Error(`HTTP ${response.status}: ${await response.text()}`);
      } catch (err) {
        lastError = err as Error;
      }
    }

    throw new WfeError(
      `core.http request to ${url} failed after ${retries + 1} attempt(s): ${lastError?.message}`,
      { statusCode: 502, code: "HTTP_STEP_FAILED", cause: lastError },
    );
  }
}
