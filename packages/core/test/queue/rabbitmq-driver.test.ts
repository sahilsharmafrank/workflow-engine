import { RabbitMQContainer, StartedRabbitMQContainer } from "@testcontainers/rabbitmq";
import { RabbitMqQueueDriver } from "../../src/queue/rabbitmq-driver";
import { WorkflowMessage } from "../../src/queue/types";

jest.setTimeout(180000);

const msg = (runId: number): WorkflowMessage => ({
  tenantId: "default", runId, stepNumber: 0, kind: "resume",
});

/** Waits for a predicate, polling — brokers are asynchronous. */
async function eventually(check: () => boolean, timeoutMs = 20000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("condition not met within timeout");
}

describe("RabbitMqQueueDriver", () => {
  let container: StartedRabbitMQContainer;
  let driver: RabbitMqQueueDriver;

  beforeAll(async () => {
    container = await new RabbitMQContainer("rabbitmq:3.13-alpine").start();
    driver = new RabbitMqQueueDriver({ url: container.getAmqpUrl() });
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
    await eventually(() => received.length === 1);
    expect(received[0].runId).toBe(1);

    await stop();
  });

  it("preserves every field of the envelope", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });

    await driver.publish("work", {
      tenantId: "t1", runId: 7, stepNumber: 3, kind: "callback",
      body: { receiptId: "r-1" }, correlationId: "7:3", attempt: 120,
    });
    await eventually(() => received.length === 1);
    expect(received[0]).toEqual({
      tenantId: "t1", runId: 7, stepNumber: 3, kind: "callback",
      body: { receiptId: "r-1" }, correlationId: "7:3", attempt: 120,
    });

    await stop();
  });

  it("holds a delayed message and delivers it after the delay", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });

    const publishedAt = Date.now();
    await driver.publish("work", msg(2), { delaySeconds: 3 });
    expect(received).toHaveLength(0);

    await eventually(() => received.length === 1, 30000);
    expect(Date.now() - publishedAt).toBeGreaterThanOrEqual(2500);

    await stop();
  });

  it("redelivers a message whose handler threw", async () => {
    let attempts = 0;
    const stop = await driver.subscribe("work", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("handler blew up");
    });

    await driver.publish("work", msg(3));
    await eventually(() => attempts >= 2, 30000);

    await stop();
  });

  it("stops delivering after unsubscribe", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });
    await stop();

    await driver.publish("work", msg(4));
    await new Promise((r) => setTimeout(r, 2000));
    expect(received).toHaveLength(0);
  });
});
