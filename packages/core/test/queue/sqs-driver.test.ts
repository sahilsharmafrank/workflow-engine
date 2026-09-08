import { LocalstackContainer, StartedLocalStackContainer } from "@testcontainers/localstack";
import { SqsQueueDriver } from "../../src/queue/sqs-driver";
import { WorkflowMessage } from "../../src/queue/types";

jest.setTimeout(180000);

const msg = (runId: number): WorkflowMessage => ({
  tenantId: "default", runId, stepNumber: 0, kind: "resume",
});

async function eventually(check: () => boolean, timeoutMs = 30000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("condition not met within timeout");
}

describe("SqsQueueDriver", () => {
  let container: StartedLocalStackContainer;
  let driver: SqsQueueDriver;

  beforeAll(async () => {
    container = await new LocalstackContainer("localstack/localstack:3").start();
    driver = new SqsQueueDriver({
      region: "us-east-1",
      prefix: "wfe-test",
      endpoint: container.getConnectionUri(),
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await driver.ensureQueues([{ queueName: "work" }]);
  });

  afterAll(async () => {
    await driver.close();
    await container.stop();
  });

  it("round-trips a message", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });

    await driver.publish("work", msg(1));
    await eventually(() => received.length >= 1);
    expect(received[0].runId).toBe(1);

    await stop();
  });

  it("preserves every field of the envelope", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });

    await driver.publish("work", {
      tenantId: "t1", runId: 9, stepNumber: 2, kind: "callback",
      body: { ok: true }, correlationId: "9:2", attempt: 30, remainingDelaySeconds: 45,
    });
    await eventually(() => received.length >= 1);
    expect(received[0]).toEqual({
      tenantId: "t1", runId: 9, stepNumber: 2, kind: "callback",
      body: { ok: true }, correlationId: "9:2", attempt: 30, remainingDelaySeconds: 45,
    });

    await stop();
  });

  it("applies a native delay", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });

    const publishedAt = Date.now();
    await driver.publish("work", msg(2), { delaySeconds: 3 });
    await eventually(() => received.some((m) => m.runId === 2), 40000);
    expect(Date.now() - publishedAt).toBeGreaterThanOrEqual(2500);

    await stop();
  });

  it("caps delay at the SQS maximum", () => {
    expect(driver.maxDelaySeconds).toBe(900);
  });

  it("redelivers a message whose handler threw", async () => {
    let attempts = 0;
    const stop = await driver.subscribe("work", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("handler blew up");
    });

    await driver.publish("work", msg(3));
    await eventually(() => attempts >= 2, 60000);

    await stop();
  });
});
