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

  // The test server above is only reachable at 127.0.0.1 — a loopback
  // address the SSRF guard (see the "SSRF protection" suite below) refuses
  // by default. Every functional test in this suite needs it explicitly
  // allowed; the guard itself is exercised separately, in isolation.
  beforeEach(() => { process.env.WFE_HTTP_ALLOW_PRIVATE_HOSTS = "true"; });
  afterEach(() => { delete process.env.WFE_HTTP_ALLOW_PRIVATE_HOSTS; });

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

describe("HttpStep SSRF protection", () => {
  const httpStep = new HttpStep({ name: "H", version: "1.0.0", type: "core.http" });

  afterEach(() => { delete process.env.WFE_HTTP_ALLOW_PRIVATE_HOSTS; });

  it("refuses a loopback target by default", async () => {
    delete process.env.WFE_HTTP_ALLOW_PRIVATE_HOSTS;
    const ctx = makeCtx({ url: `${baseUrl}/ok` }); // baseUrl is 127.0.0.1
    await expect(httpStep.run(ctx as any)).rejects.toMatchObject({
      statusCode: 400, code: "HTTP_STEP_BLOCKED_HOST",
    });
  });

  it("permits a loopback target once WFE_HTTP_ALLOW_PRIVATE_HOSTS=true", async () => {
    process.env.WFE_HTTP_ALLOW_PRIVATE_HOSTS = "true";
    const ctx = makeCtx({ url: `${baseUrl}/ok` });
    const result = await httpStep.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
    expect(result.stepState.outputs).toMatchObject({ status: 200 });
  });

  it("refuses a redirect that lands on a blocked host, even though the initial URL is allowed", async () => {
    delete process.env.WFE_HTTP_ALLOW_PRIVATE_HOSTS;

    // 8.8.8.8 is a literal, public IP — assertHostAllowed clears it without
    // any real DNS lookup or network call. fetch itself is mocked so no real
    // request is issued to it either: this isolates "does the redirect
    // target get checked independently of the initial URL" from any
    // dependency on real network access in the test environment.
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" },
      })
    );

    try {
      const ctx = makeCtx({ url: "http://8.8.8.8/redirect-to-metadata" });
      await expect(httpStep.run(ctx as any)).rejects.toMatchObject({
        statusCode: 400, code: "HTTP_STEP_BLOCKED_HOST",
      });
      // The blocked redirect target must never actually be requested.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// Regression coverage for the IPv4-mapped/IPv4-compatible IPv6 bypass fixed
// after `13d5476`: `new URL(...)` canonicalises a bracketed IPv6 literal to
// hex *before* the guard ever sees it (e.g. the hostname of
// "http://[::ffff:169.254.169.254]/" is "[::ffff:a9fe:a9fe]"), so the old
// text regex over the dotted form never matched. Every case below is
// exercised as a real request through `HttpStep.run`, using the exact string
// an attacker would put in a URL — not by calling the internal helper with a
// hand-typed address — so the assertion is only satisfied if the guard
// actually intercepts the request Node itself would issue.
describe("HttpStep SSRF protection — IPv4-mapped/compatible IPv6 bypass", () => {
  const httpStep = new HttpStep({ name: "H", version: "1.0.0", type: "core.http" });

  afterEach(() => {
    delete process.env.WFE_HTTP_ALLOW_PRIVATE_HOSTS;
    jest.restoreAllMocks();
  });

  const attacks: Array<[string, string]> = [
    ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback (compressed)"],
    ["http://[::ffff:169.254.169.254]/", "IPv4-mapped cloud metadata address (compressed)"],
    ["http://[0:0:0:0:0:ffff:7f00:1]/", "IPv4-mapped loopback (fully expanded form)"],
    ["http://[::127.0.0.1]/", "IPv4-compatible loopback (deprecated ::a.b.c.d form)"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://[::]/", "IPv6 unspecified address"],
    ["http://0.0.0.0/", "0.0.0.0"],
  ];

  it.each(attacks)("refuses %s (%s)", async (url) => {
    // If the guard fails to intercept this, fetch would actually be called
    // (and, on the buggy code, the mock makes it "succeed" instead of
    // erroring for an unrelated reason like ECONNREFUSED) — so this fails
    // loudly and fast on the bug rather than timing out against a real
    // socket.
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      const ctx = makeCtx({ url });
      await expect(httpStep.run(ctx as any)).rejects.toMatchObject({
        statusCode: 400, code: "HTTP_STEP_BLOCKED_HOST",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("refuses a redirect whose target is an IPv4-mapped IPv6 metadata address", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://[::ffff:169.254.169.254]/latest/meta-data/" },
      })
    );
    try {
      const ctx = makeCtx({ url: "http://8.8.8.8/redirect-to-mapped-metadata" });
      await expect(httpStep.run(ctx as any)).rejects.toMatchObject({
        statusCode: 400, code: "HTTP_STEP_BLOCKED_HOST",
      });
      // Only the initial hop should ever reach fetch; the mapped redirect
      // target must be intercepted before a second call is made.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("still allows a legitimate public IPv4 address", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    );
    try {
      const ctx = makeCtx({ url: "http://8.8.8.8/" });
      const result = await httpStep.run(ctx as any);
      expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("still allows a legitimate public IPv6 address", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    );
    try {
      const ctx = makeCtx({ url: "http://[2001:4860:4860::8888]/" });
      const result = await httpStep.run(ctx as any);
      expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("WFE_HTTP_ALLOW_PRIVATE_HOSTS=true still relaxes the mapped-IPv6 and 0.0.0.0 checks", async () => {
    process.env.WFE_HTTP_ALLOW_PRIVATE_HOSTS = "true";
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    );
    try {
      for (const [url] of attacks) {
        const ctx = makeCtx({ url });
        const result = await httpStep.run(ctx as any);
        expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
