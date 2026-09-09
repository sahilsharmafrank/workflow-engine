import "reflect-metadata";
import { WorkflowStatus } from "@wfe/sdk";
import { DelayStep } from "../../src/steps/delay-step";

function makeCtx(inputs: Record<string, unknown>, isResume = false) {
  const step: any = { status: isResume ? WorkflowStatus.WAITING : WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} };
  return {
    config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    services: {}, run: {} as any, step, stepNumber: 0,
    inputs, isResume,
  };
}

describe("DelayStep", () => {
  const delay = new DelayStep({ name: "D", version: "1.0.0", type: "core.delay" });

  it("suspends with delay on first entry", async () => {
    const ctx = makeCtx({ seconds: 30 });
    const result = await delay.run(ctx as any);
    expect(result.suspend).toEqual({ kind: "delay", delaySeconds: 30 });
    expect(result.stepState.status).toBe(WorkflowStatus.WAITING);
  });

  it("completes on resume", async () => {
    const ctx = makeCtx({}, true);
    const result = await delay.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
  });

  it("throws DELAY_INVALID_SECONDS for NaN input", async () => {
    const ctx = makeCtx({ seconds: "not-a-number" });
    await expect(delay.run(ctx as any)).rejects.toMatchObject({
      code: "DELAY_INVALID_SECONDS",
    });
  });

  it("throws DELAY_INVALID_SECONDS for negative input", async () => {
    const ctx = makeCtx({ seconds: -5 });
    await expect(delay.run(ctx as any)).rejects.toMatchObject({
      code: "DELAY_INVALID_SECONDS",
    });
  });
});
