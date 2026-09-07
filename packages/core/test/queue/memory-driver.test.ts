import { MemoryQueueDriver } from "../../src/queue/memory-driver";
import { WorkflowMessage } from "../../src/queue/types";

const msg = (runId: number): WorkflowMessage => ({
  tenantId: "default", runId, stepNumber: 0, kind: "resume",
});

describe("MemoryQueueDriver", () => {
  let driver: MemoryQueueDriver;
  beforeEach(async () => {
    driver = new MemoryQueueDriver();
    await driver.ensureQueues([{ queueName: "work" }]);
  });
  afterEach(() => driver.close());

  it("delivers a published message to a subscriber", async () => {
    const received: WorkflowMessage[] = [];
    await driver.subscribe("work", async (m) => { received.push(m); });
    await driver.publish("work", msg(1));
    await driver.drain();
    expect(received).toHaveLength(1);
    expect(received[0].runId).toBe(1);
  });

  it("holds a delayed message until its delay elapses", async () => {
    const received: WorkflowMessage[] = [];
    await driver.subscribe("work", async (m) => { received.push(m); });
    await driver.publish("work", msg(2), { delaySeconds: 5 });
    await driver.drain();
    expect(received).toHaveLength(0);

    driver.advanceTime(5000);
    await driver.drain();
    expect(received).toHaveLength(1);
  });

  it("stops delivering after unsubscribe", async () => {
    const received: WorkflowMessage[] = [];
    const stop = await driver.subscribe("work", async (m) => { received.push(m); });
    await stop();
    await driver.publish("work", msg(3));
    await driver.drain();
    expect(received).toHaveLength(0);
  });

  it("redelivers a message whose handler threw", async () => {
    let attempts = 0;
    await driver.subscribe("work", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("handler blew up");
    });
    await driver.publish("work", msg(4));
    await driver.drain();
    await driver.drain();
    expect(attempts).toBe(2);
  });

  it("reports a finite max delay", () => {
    expect(driver.maxDelaySeconds).toBeGreaterThan(0);
  });
});
