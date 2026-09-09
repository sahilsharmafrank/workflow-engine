import "reflect-metadata";
import { WorkflowStatus } from "@wfe/sdk";
import { ConditionStep } from "../../src/steps/condition-step";

function makeCtx(inputs: Record<string, unknown>) {
  const step: any = { status: WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} };
  return {
    config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    services: {}, run: {} as any, step, stepNumber: 0,
    inputs, isResume: false,
  };
}

describe("ConditionStep", () => {
  const condStep = new ConditionStep({ name: "C", version: "1.0.0", type: "core.condition" });

  it("completes when condition is truthy", async () => {
    const ctx = makeCtx({ condition: true });
    const result = await condStep.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
  });

  it("marks SKIPPED when condition is falsy and action is skip", async () => {
    const ctx = makeCtx({ condition: false, action: "skip" });
    const result = await condStep.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.SKIPPED);
  });

  it("marks SKIPPED when condition is falsy and action is omitted (default)", async () => {
    const ctx = makeCtx({ condition: false });
    const result = await condStep.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.SKIPPED);
  });

  it("throws when condition is falsy and action is fail", async () => {
    const ctx = makeCtx({ condition: false, action: "fail", message: "not ready" });
    await expect(condStep.run(ctx as any)).rejects.toMatchObject({
      code: "CONDITION_FAILED",
    });
  });
});
