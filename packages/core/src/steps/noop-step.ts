import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

export class NoopStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
