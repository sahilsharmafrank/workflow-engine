import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { WfeError } from "../errors";

export class ConditionStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    const { condition, action, message } = ctx.inputs as {
      condition: unknown;
      action?: string;
      message?: string;
    };

    if (condition) {
      ctx.step.status = WorkflowStatus.COMPLETE;
      return { stepState: ctx.step };
    }

    const effectiveAction = action ?? "skip";
    if (effectiveAction === "fail") {
      throw new WfeError(message ?? "Condition check failed", {
        statusCode: 400,
        code: "CONDITION_FAILED",
      });
    }

    ctx.step.status = WorkflowStatus.SKIPPED;
    ctx.step.message = message ?? "Condition was falsy; step skipped";
    return { stepState: ctx.step };
  }
}
