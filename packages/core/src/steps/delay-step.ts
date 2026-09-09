import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { WfeError } from "../errors";

/** Suspends the run for the number of seconds named by its `seconds` input. */
export class DelayStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (ctx.isResume) {
      ctx.step.status = WorkflowStatus.COMPLETE;
      return { stepState: ctx.step };
    }
    const seconds = Number(ctx.inputs.seconds ?? 0);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new WfeError(
        `delay seconds must be a non-negative number, got: ${ctx.inputs.seconds}`,
        { statusCode: 400, code: "DELAY_INVALID_SECONDS" },
      );
    }
    ctx.step.status = WorkflowStatus.WAITING;
    return { stepState: ctx.step, suspend: { kind: "delay", delaySeconds: seconds } };
  }
}
