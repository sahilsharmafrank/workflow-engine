import { BaseStep, RunStepResponse, StepContext, StepParams, WorkflowStatus } from "@wfe/sdk";
import { StepRegistry, registerBuiltInSteps } from "../../src/registry/step-registry";

class DummyStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

function context(inputs: Record<string, unknown>): StepContext {
  return {
    config: {},
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    services: {},
    inputs,
    stepNumber: 0,
    run: {
      tenantId: "default", name: "t", version: "1.0.0", currentStep: 0,
      status: WorkflowStatus.RUNNING, inputs: {}, outputs: {}, state: {},
    },
    step: {
      stepNumber: 0, stepName: "S", stepType: "core.transform",
      status: WorkflowStatus.RUNNING, inputs: {}, outputs: {}, state: {},
    },
  };
}

describe("StepRegistry", () => {
  const params: StepParams = { name: "S", version: "1.0.0", type: "test.dummy" };

  it("registers and creates a step by type", () => {
    const registry = new StepRegistry();
    registry.register({ type: "test.dummy", version: "1.0.0", factory: (p) => new DummyStep(p) });
    expect(registry.has("test.dummy")).toBe(true);
    expect(registry.create("test.dummy", params)).toBeInstanceOf(DummyStep);
  });

  it("rejects a duplicate registration", () => {
    const registry = new StepRegistry();
    const reg = { type: "test.dummy", version: "1.0.0", factory: (p: StepParams) => new DummyStep(p) };
    registry.register(reg);
    expect(() => registry.register(reg)).toThrow(/already registered/);
  });

  it("throws a helpful error for an unknown type", () => {
    const registry = new StepRegistry();
    expect(() => registry.create("nope.missing", params)).toThrow(/nope\.missing/);
  });

  it("lists registrations", () => {
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    expect(registry.list().map((r) => r.type).sort()).toEqual(["core.noop", "core.transform"]);
  });

  it("core.transform copies resolved inputs to outputs and completes", async () => {
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    const step = registry.create("core.transform", { ...params, type: "core.transform" });
    const ctx = context({ total: 12, label: "ready" });
    const response = await step.run(ctx);
    expect(response.stepState.outputs).toEqual({ total: 12, label: "ready" });
    expect(response.stepState.status).toBe(WorkflowStatus.COMPLETE);
  });

  it("core.noop completes without producing outputs", async () => {
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    const step = registry.create("core.noop", { ...params, type: "core.noop" });
    const response = await step.run(context({ ignored: true }));
    expect(response.stepState.outputs).toEqual({});
    expect(response.stepState.status).toBe(WorkflowStatus.COMPLETE);
  });
});
