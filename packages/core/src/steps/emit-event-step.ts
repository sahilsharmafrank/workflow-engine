import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { WfeError } from "../errors";

export class EmitEventStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (!ctx.queue) {
      throw new WfeError("core.emitEvent requires a queue driver but none is configured", {
        statusCode: 500,
        code: "QUEUE_NOT_CONFIGURED",
      });
    }

    const { queue, payload } = ctx.inputs as { queue: string; payload: unknown };
    await ctx.queue.publish(queue, payload);

    ctx.step.outputs = { queue, published: true };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
