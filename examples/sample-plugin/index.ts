import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

class EchoStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.outputs = { ...ctx.inputs };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}

export default function register(registry: import("@wfe/core").StepRegistry): void {
  registry.register({
    type: "sample.echo",
    version: "1.0.0",
    description: "Echoes its resolved inputs to outputs. Demo plugin.",
    factory: (params) => new EchoStep(params),
  });
}
