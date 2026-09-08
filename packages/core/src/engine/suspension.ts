import { StepSuspension } from "@wfe/sdk";
import { WfeError } from "../errors";
import { DELAY_QUEUE, serviceQueueName } from "../queue/names";

export interface SuspensionPlan {
  queue: string;
  /** Delay to apply to this hop, never more than the driver allows. */
  delaySeconds: number;
  /** Seconds still owed after this hop; > 0 means core must chain another. */
  remaining: number;
}

/**
 * Decides where a suspension's resume message goes and how long it waits.
 * Pure, so the chaining arithmetic is testable without a broker.
 */
export function planSuspension(suspend: StepSuspension, driverMaxSeconds: number): SuspensionPlan {
  if (suspend.kind === "awaitCallback") {
    if (!suspend.queue) {
      // Routing this to DELAY_QUEUE with delaySeconds: 0 would make the
      // resume message visible immediately once something consumes that
      // queue — the step would re-enter with isResume === true and complete
      // as though the external reply had already arrived. There is nothing
      // to schedule without a named queue, so fail loudly instead.
      throw new WfeError(
        "An awaitCallback suspension must name the queue the callback request was sent to",
        { statusCode: 500, code: "CALLBACK_QUEUE_NOT_SPECIFIED" }
      );
    }
    return { queue: serviceQueueName(suspend.queue), delaySeconds: 0, remaining: 0 };
  }

  const requested = Math.max(0, Math.floor(suspend.delaySeconds));
  const thisHop = Math.min(requested, driverMaxSeconds);
  return { queue: DELAY_QUEUE, delaySeconds: thisHop, remaining: requested - thisHop };
}
