import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

/** Suspends the run for the number of seconds named by its `seconds` input. */
export class DelayStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (ctx.isResume) {
      ctx.step.status = WorkflowStatus.COMPLETE;
      return { stepState: ctx.step };
    }
    const seconds = Number(ctx.inputs.seconds ?? 0);
    ctx.step.status = WorkflowStatus.WAITING;
    return { stepState: ctx.step, suspend: { kind: "delay", delaySeconds: seconds } };
  }
}
