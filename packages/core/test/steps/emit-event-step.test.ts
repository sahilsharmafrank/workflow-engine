import "reflect-metadata";
import { WorkflowStatus } from "@wfe/sdk";
import { EmitEventStep } from "../../src/steps/emit-event-step";

describe("EmitEventStep", () => {
  const step = new EmitEventStep({ name: "E", version: "1.0.0", type: "core.emitEvent" });

  it("publishes to the named queue and completes", async () => {
    const published: Array<{ queue: string; msg: unknown }> = [];
    const ctx: any = {
      config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      services: {}, run: {} as any,
      step: { status: WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} },
      stepNumber: 0, inputs: { queue: "test-queue", payload: { key: "val" } },
      isResume: false,
      queue: { publish: async (q: string, m: unknown) => { published.push({ queue: q, msg: m }); } },
    };
    const result = await step.run(ctx);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
    expect(published).toEqual([{ queue: "test-queue", msg: { key: "val" } }]);
  });

  it("throws QUEUE_NOT_CONFIGURED when no queue is available", async () => {
    const ctx: any = {
      config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      services: {}, run: {} as any,
      step: { status: WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} },
      stepNumber: 0, inputs: { queue: "q", payload: {} },
      isResume: false,
      // no queue
    };
    await expect(step.run(ctx)).rejects.toMatchObject({ code: "QUEUE_NOT_CONFIGURED" });
  });
});
