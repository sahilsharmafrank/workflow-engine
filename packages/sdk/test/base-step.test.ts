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
    isResume: false,
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
    expect(response.suspend).toBeUndefined();
  });

  it("provides a no-op start hook by default", async () => {
    const ctx = makeContext({});
    await expect(new EchoStep(params).start(ctx)).resolves.toBeUndefined();
  });
});

class SuspendingStep extends BaseStep {
  startCalls = 0;
  runCalls = 0;

  async start(_ctx: StepContext): Promise<void> {
    this.startCalls += 1;
  }

  async run(ctx: StepContext): Promise<RunStepResponse> {
    this.runCalls += 1;
    if (!ctx.isResume) {
      ctx.step.status = WorkflowStatus.WAITING;
      return { stepState: ctx.step, suspend: { kind: "delay", delaySeconds: 30 } };
    }
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

class AwaitCallbackStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (!ctx.isResume) {
      ctx.step.status = WorkflowStatus.WAITING;
      return {
        stepState: ctx.step,
        suspend: { kind: "awaitCallback", queue: "billing", correlationId: "abc" },
      };
    }
    ctx.step.status = WorkflowStatus.COMPLETE;
    ctx.step.outputs = (ctx.body as Record<string, unknown>) ?? {};
    return { stepState: ctx.step };
  }
}

describe("suspension model", () => {
  const params: StepParams = { name: "S", version: "1.0.0", type: "test.suspending" };

  function ctx(isResume: boolean): StepContext {
    return {
      config: {}, services: {}, inputs: {}, stepNumber: 0, isResume,
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      run: {
        tenantId: "default", name: "t", version: "1.0.0", currentStep: 0,
        status: WorkflowStatus.RUNNING, inputs: {}, outputs: {}, state: {},
      },
      step: {
        stepNumber: 0, stepName: "S", stepType: "test.suspending",
        status: WorkflowStatus.RUNNING, inputs: {}, outputs: {}, state: {},
      },
    };
  }

  it("suspends with a delay on first entry", async () => {
    const step = new SuspendingStep(params);
    const response = await step.run(ctx(false));
    expect(response.suspend).toEqual({ kind: "delay", delaySeconds: 30 });
    expect(response.stepState.status).toBe(WorkflowStatus.WAITING);
  });

  it("completes without suspending on resume", async () => {
    const step = new SuspendingStep(params);
    const response = await step.run(ctx(true));
    expect(response.suspend).toBeUndefined();
    expect(response.stepState.status).toBe(WorkflowStatus.COMPLETE);
  });

  it("expresses an await-callback suspension", async () => {
    const step = new AwaitCallbackStep(params);
    const response = await step.run(ctx(false));
    expect(response.suspend).toEqual({ kind: "awaitCallback", queue: "billing", correlationId: "abc" });
    expect(response.stepState.status).toBe(WorkflowStatus.WAITING);
  });

  it("completes with the callback body on resume", async () => {
    const step = new AwaitCallbackStep(params);
    const resumeCtx = ctx(true);
    resumeCtx.body = { receiptId: "rcpt-1" };
    const response = await step.run(resumeCtx);
    expect(response.suspend).toBeUndefined();
    expect(response.stepState.status).toBe(WorkflowStatus.COMPLETE);
    expect(response.stepState.outputs).toEqual({ receiptId: "rcpt-1" });
  });

  it("provides a no-op start hook by default", async () => {
    class Bare extends BaseStep {
      async run(c: StepContext): Promise<RunStepResponse> { return { stepState: c.step }; }
    }
    await expect(new Bare(params).start(ctx(false))).resolves.toBeUndefined();
  });
});
