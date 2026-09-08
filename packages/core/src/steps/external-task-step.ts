import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

/**
 * Dispatches its inputs to an external service's queue and parks the run until
 * that service replies. On resumption the reply payload arrives as `ctx.body`
 * and becomes the step's outputs.
 *
 * The service name comes from the step definition's `externalServiceName`,
 * surfaced on the step row the executor hands to the context.
 */
export class ExternalTaskStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (ctx.isResume) {
      ctx.step.outputs = (ctx.body as Record<string, unknown>) ?? {};
      ctx.step.status = WorkflowStatus.COMPLETE;
      return { stepState: ctx.step };
    }

    ctx.step.status = WorkflowStatus.WAITING;
    ctx.step.message = `Awaiting reply from "${ctx.step.externalServiceName ?? "unnamed service"}"`;
    return {
      stepState: ctx.step,
      suspend: {
        kind: "awaitCallback",
        queue: ctx.step.externalServiceName,
        correlationId: `${ctx.run.id}:${ctx.stepNumber}`,
      },
    };
  }
}
