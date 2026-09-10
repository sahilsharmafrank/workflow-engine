import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { WfeError } from "../errors";
import { DELAY_QUEUE, RESPONSE_QUEUE } from "../queue/names";

// The engine trusts every message it reads off these two queues (a resume for
// DELAY_QUEUE, an external callback for RESPONSE_QUEUE) — that trust model is
// core.externalTask's whole basis. Referencing the exported constants, rather
// than retyping "wfe-delay"/"wfe-response" here, means this check can't drift
// out of sync if either queue is ever renamed.
const RESERVED_QUEUES: ReadonlySet<string> = new Set([DELAY_QUEUE, RESPONSE_QUEUE]);

export class EmitEventStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (!ctx.queue) {
      throw new WfeError("core.emitEvent requires a queue driver but none is configured", {
        statusCode: 500,
        code: "QUEUE_NOT_CONFIGURED",
      });
    }

    const { queue, payload } = ctx.inputs as { queue: string; payload: unknown };

    if (typeof queue !== "string" || queue.trim() === "") {
      throw new WfeError("core.emitEvent requires a non-empty queue name", {
        statusCode: 400,
        code: "EMIT_EVENT_INVALID_QUEUE",
      });
    }

    // Without this, a workflow definition could publish straight onto the
    // engine's own control queues and forge a resume or callback message for
    // an arbitrary run — bypassing core.externalTask's trust model entirely.
    if (RESERVED_QUEUES.has(queue)) {
      throw new WfeError(
        `core.emitEvent cannot publish to the reserved engine queue "${queue}"`,
        { statusCode: 400, code: "EMIT_EVENT_RESERVED_QUEUE" }
      );
    }

    await ctx.queue.publish(queue, payload);

    ctx.step.outputs = { queue, published: true };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
