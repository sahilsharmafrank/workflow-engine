import "reflect-metadata";
import { WorkflowStatus } from "@wfe/sdk";
import { SubWorkflowStep } from "../../src/steps/sub-workflow-step";

function makeCtx(inputs: Record<string, unknown>, startChildWorkflow?: Function) {
  const step: any = { status: WorkflowStatus.RUNNING, outputs: {}, state: {}, inputs: {} };
  return {
    config: {}, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    services: {}, run: { tenantId: "default" } as any, step, stepNumber: 0,
    inputs, isResume: false,
    startChildWorkflow,
  };
}

describe("SubWorkflowStep", () => {
  const subStep = new SubWorkflowStep({ name: "S", version: "1.0.0", type: "core.subWorkflow" });

  it("starts a child workflow and records the runId in outputs", async () => {
    const starter = jest.fn().mockResolvedValue(42);
    const ctx = makeCtx({ name: "child-wf", version: "1.0.0", inputs: { a: 1 } }, starter);
    const result = await subStep.run(ctx as any);
    expect(result.stepState.status).toBe(WorkflowStatus.COMPLETE);
    expect(result.stepState.outputs).toEqual({ childRunId: 42 });
    expect(starter).toHaveBeenCalledWith({ name: "child-wf", version: "1.0.0", inputs: { a: 1 } });
  });

  it("throws when startChildWorkflow is not available", async () => {
    const ctx = makeCtx({ name: "child-wf", version: "1.0.0", inputs: {} });
    await expect(subStep.run(ctx as any)).rejects.toMatchObject({
      code: "SUB_WORKFLOW_NOT_AVAILABLE",
    });
  });
});
