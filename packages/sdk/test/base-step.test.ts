import {
  BaseStep,
  RunStepResponse,
  StepContext,
  StepParams,
  WorkflowStatus,
} from "../src";

class EchoStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.outputs = { echoed: ctx.inputs.message };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

function makeContext(inputs: Record<string, unknown>): StepContext {
  return {
    config: {},
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    services: {},
    inputs,
    stepNumber: 0,
    run: {
      tenantId: "default",
      name: "t",
      version: "1.0.0",
      currentStep: 0,
      status: WorkflowStatus.RUNNING,
      inputs: {},
      outputs: {},
      state: {},
    },
    step: {
      stepNumber: 0,
      stepName: "Echo",
      stepType: "test.echo",
      status: WorkflowStatus.RUNNING,
      inputs: {},
      outputs: {},
      state: {},
    },
  };
}

describe("BaseStep", () => {
  const params: StepParams = { name: "Echo", version: "1.0.0", type: "test.echo" };

  it("exposes its declared identity", () => {
    const step = new EchoStep(params);
    expect(step.name).toBe("Echo");
    expect(step.type).toBe("test.echo");
    expect(step.version).toBe("1.0.0");
  });

  it("runs and writes outputs onto the step state", async () => {
    const ctx = makeContext({ message: "hello" });
    const response = await new EchoStep(params).run(ctx);
    expect(response.stepState.outputs).toEqual({ echoed: "hello" });
    expect(response.delaySeconds).toBeUndefined();
  });

  it("provides a no-op onBeforeRun hook by default", async () => {
    const ctx = makeContext({});
    await expect(new EchoStep(params).onBeforeRun(ctx)).resolves.toBeUndefined();
  });
});
