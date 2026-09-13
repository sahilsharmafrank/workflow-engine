import { BaseStep, WorkflowStatus } from "@wfe/sdk";
import type { RunStepResponse, StepContext } from "@wfe/sdk";

export class EchoStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.outputs = { ...ctx.inputs };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
