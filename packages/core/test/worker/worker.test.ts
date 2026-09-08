import { WorkflowStatus } from "@wfe/sdk";
import { MemoryQueueDriver } from "../../src/queue/memory-driver";
import { DELAY_QUEUE, RESPONSE_QUEUE, serviceQueueName } from "../../src/queue/names";
import { WorkflowMessage } from "../../src/queue/types";
import { WfeError } from "../../src/errors";
import { WorkflowWorker } from "../../src/worker/worker";

describe("WorkflowWorker", () => {
  let queue: MemoryQueueDriver;

  beforeEach(async () => {
    queue = new MemoryQueueDriver();
    await queue.ensureQueues([{ queueName: DELAY_QUEUE }, { queueName: RESPONSE_QUEUE }]);
  });

  afterEach(() => queue.close());

  function fakeExecutor(overrides: Partial<Record<"resume" | "callback", jest.Mock>> = {}) {
    return {
      resume: overrides.resume ?? jest.fn().mockResolvedValue({ status: WorkflowStatus.COMPLETE }),
      callback: overrides.callback ?? jest.fn().mockResolvedValue({ status: WorkflowStatus.COMPLETE }),
    };
  }

  const resumeMsg: WorkflowMessage = {
    tenantId: "default", runId: 1, stepNumber: 0, kind: "resume",
  };
  const callbackMsg: WorkflowMessage = {
    tenantId: "default", runId: 2, stepNumber: 1, kind: "callback", body: { ok: true },
  };

  it("routes a resume message to executor.resume", async () => {
    const executor = fakeExecutor();
    const worker = new WorkflowWorker({ executor: executor as never, queue });
    await worker.start();

    await queue.publish(DELAY_QUEUE, resumeMsg);
    await queue.drain();

    expect(executor.resume).toHaveBeenCalledWith(resumeMsg);
    await worker.stop();
  });

  it("routes a callback message to executor.callback with its payload", async () => {
    const executor = fakeExecutor();
    const worker = new WorkflowWorker({ executor: executor as never, queue });
    await worker.start();

    await queue.publish(RESPONSE_QUEUE, callbackMsg);
    await queue.drain();

    expect(executor.callback).toHaveBeenCalledWith("default", 2, 1, { ok: true });
    await worker.stop();
  });

  it("leaves a message for redelivery when the handler fails transiently", async () => {
    const resume = jest.fn().mockRejectedValue(new Error("database down"));
    const worker = new WorkflowWorker({ executor: fakeExecutor({ resume }) as never, queue });
    await worker.start();

    await queue.publish(DELAY_QUEUE, resumeMsg);
    await queue.drain();
    expect(queue.pending(DELAY_QUEUE)).toHaveLength(1);

    await worker.stop();
  });

  it("consumes a message whose run conflicts — another consumer won", async () => {
    const resume = jest.fn().mockRejectedValue(
      new WfeError("conflict", { statusCode: 409, code: "RUN_CONFLICT" })
    );
    const worker = new WorkflowWorker({ executor: fakeExecutor({ resume }) as never, queue });
    await worker.start();

    await queue.publish(DELAY_QUEUE, resumeMsg);
    await queue.drain();
    expect(queue.pending(DELAY_QUEUE)).toHaveLength(0);

    await worker.stop();
  });

  it("consumes a message whose run no longer exists", async () => {
    const resume = jest.fn().mockRejectedValue(
      new WfeError("gone", { statusCode: 404, code: "RUN_NOT_FOUND" })
    );
    const worker = new WorkflowWorker({ executor: fakeExecutor({ resume }) as never, queue });
    await worker.start();

    await queue.publish(DELAY_QUEUE, resumeMsg);
    await queue.drain();
    expect(queue.pending(DELAY_QUEUE)).toHaveLength(0);

    await worker.stop();
  });

  it("stops delivering after stop()", async () => {
    const executor = fakeExecutor();
    const worker = new WorkflowWorker({ executor: executor as never, queue });
    await worker.start();
    await worker.stop();

    await queue.publish(DELAY_QUEUE, resumeMsg);
    await queue.drain();
    expect(executor.resume).not.toHaveBeenCalled();
  });

  it("never subscribes to a service's dispatch queue (regression guard: the engine must not consume its own outbound external-task dispatch)", async () => {
    const executor = fakeExecutor();
    const worker = new WorkflowWorker({ executor: executor as never, queue });
    await worker.start();

    // Make sure the queue genuinely exists in the driver before publishing,
    // so a passing test here can't be explained by MemoryQueueDriver simply
    // never having heard of the queue name.
    const dispatchQueue = serviceQueueName("billing");
    await queue.ensureQueues([{ queueName: dispatchQueue }]);

    const dispatchEcho: WorkflowMessage = {
      tenantId: "default", runId: 3, stepNumber: 0, kind: "resume",
    };
    await queue.publish(dispatchQueue, dispatchEcho);
    await queue.drain();

    // No subscription means no handler for this queue: drain() must leave
    // the message exactly where it was, and the executor must never see it.
    expect(executor.resume).not.toHaveBeenCalled();
    expect(queue.pending(dispatchQueue)).toEqual([dispatchEcho]);
    await worker.stop();
  });

  it("tolerates stop() before start() and a second stop() after it", async () => {
    const worker = new WorkflowWorker({ executor: fakeExecutor() as never, queue });

    await expect(worker.stop()).resolves.toBeUndefined();

    await worker.start();
    await worker.stop();
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
