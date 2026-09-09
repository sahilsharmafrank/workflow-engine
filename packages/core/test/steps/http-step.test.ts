import "reflect-metadata";
import { createServer, Server } from "http";
import { WorkflowStatus } from "@wfe/sdk";
import { HttpStep } from "../../src/steps/http-step";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ greeting: "hello" }));
    } else if (req.url === "/fail-then-ok") {
      // Fails first time, succeeds second
      const count = Number(req.headers["x-attempt"] ?? "1");
      if (count <= 1) {
        res.writeHead(500);
        res.end("server error");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ retried: true }));
      }
    } else if (req.url === "/post-echo") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    } else if (req.url === "/slow") {
      // Never responds — tests timeout
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => { server.close(); });

function makeCtx(inputs: Record<string, unknown>) {
  const step: any = { status: WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} };
  return {
    config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    services: {}, run: {} as any, step, stepNumber: 0,
    inputs, isResume: false,
  };
}

describe("HttpStep", () => {
  const httpStep = new HttpStep({ name: "H", version: "1.0.0", type: "core.http" });

  it("makes a GET request and captures the response", async () => {
    const ctx = makeCtx({ url: `${baseUrl}/ok` });
    const result = await httpStep.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
    expect(result.stepState.outputs).toMatchObject({
      status: 200,
      body: { greeting: "hello" },
    });
  });

  it("makes a POST request with a JSON body", async () => {
    const ctx = makeCtx({
      url: `${baseUrl}/post-echo`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { key: "value" },
    });
    const result = await httpStep.run(ctx as any);
    expect(result.stepState.outputs.body).toEqual({ key: "value" });
  });

  it("fails on non-2xx after exhausting retries", async () => {
    const ctx = makeCtx({ url: `${baseUrl}/not-a-page`, retries: 0 });
    await expect(httpStep.run(ctx as any)).rejects.toMatchObject({
      code: "HTTP_STEP_FAILED",
    });
  });

  it("times out on a slow response", async () => {
    const ctx = makeCtx({ url: `${baseUrl}/slow`, timeoutMs: 200 });
    await expect(httpStep.run(ctx as any)).rejects.toMatchObject({
      code: "HTTP_STEP_FAILED",
    });
  });
});
