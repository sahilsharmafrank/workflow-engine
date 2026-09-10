import "reflect-metadata";
import { WorkflowStatus } from "@wfe/sdk";
import { EmitEventStep } from "../../src/steps/emit-event-step";
import { DELAY_QUEUE, RESPONSE_QUEUE } from "../../src/queue/names";

describe("EmitEventStep", () => {
  const step = new EmitEventStep({ name: "E", version: "1.0.0", type: "core.emitEvent" });

  function makeCtx(inputs: { queue: unknown; payload: unknown }, published: Array<{ queue: string; msg: unknown }>): any {
    return {
      config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      services: {}, run: {} as any,
      step: { status: WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} },
      stepNumber: 0, inputs,
      isResume: false,
      queue: { publish: async (q: string, m: unknown) => { published.push({ queue: q, msg: m }); } },
    };
  }

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

  // core.externalTask's trust model relies on DELAY_QUEUE and RESPONSE_QUEUE
  // only ever carrying messages the engine itself produced. Without this
  // guard, any workflow definition could publish straight onto them via
  // core.emitEvent and forge a resume or callback message for an arbitrary
  // run. Referencing the exported constants (rather than retyping the
  // strings) is itself part of the fix: the check can't drift if a queue is
  // ever renamed.
  it("refuses to publish to the reserved DELAY_QUEUE", async () => {
    const published: Array<{ queue: string; msg: unknown }> = [];
    const ctx = makeCtx({ queue: DELAY_QUEUE, payload: { evil: true } }, published);
    await expect(step.run(ctx)).rejects.toMatchObject({ code: "EMIT_EVENT_RESERVED_QUEUE" });
    expect(published).toEqual([]);
  });

  it("refuses to publish to the reserved RESPONSE_QUEUE", async () => {
    const published: Array<{ queue: string; msg: unknown }> = [];
    const ctx = makeCtx({ queue: RESPONSE_QUEUE, payload: { evil: true } }, published);
    await expect(step.run(ctx)).rejects.toMatchObject({ code: "EMIT_EVENT_RESERVED_QUEUE" });
    expect(published).toEqual([]);
  });

  it("still allows publishing to an ordinary, non-reserved queue", async () => {
    const published: Array<{ queue: string; msg: unknown }> = [];
    const ctx = makeCtx({ queue: "orders-created", payload: { id: 1 } }, published);
    const result = await step.run(ctx);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
    expect(published).toEqual([{ queue: "orders-created", msg: { id: 1 } }]);
  });

  // Deferred minor from the Phase 4 review ledger: an empty queue name
  // published to a queue literally named "" instead of failing.
  it("refuses an empty queue name", async () => {
    const published: Array<{ queue: string; msg: unknown }> = [];
    const ctx = makeCtx({ queue: "", payload: {} }, published);
    await expect(step.run(ctx)).rejects.toMatchObject({ code: "EMIT_EVENT_INVALID_QUEUE" });
    expect(published).toEqual([]);
  });

  it("refuses a whitespace-only queue name", async () => {
    const published: Array<{ queue: string; msg: unknown }> = [];
    const ctx = makeCtx({ queue: "   ", payload: {} }, published);
    await expect(step.run(ctx)).rejects.toMatchObject({ code: "EMIT_EVENT_INVALID_QUEUE" });
    expect(published).toEqual([]);
  });

  it("refuses a non-string queue name", async () => {
    const published: Array<{ queue: string; msg: unknown }> = [];
    const ctx = makeCtx({ queue: 123 as unknown as string, payload: {} }, published);
    await expect(step.run(ctx)).rejects.toMatchObject({ code: "EMIT_EVENT_INVALID_QUEUE" });
    expect(published).toEqual([]);
  });
});
