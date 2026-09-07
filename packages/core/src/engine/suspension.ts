import { StepSuspension } from "@wfe/sdk";
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
    return {
      queue: suspend.queue ? serviceQueueName(suspend.queue) : DELAY_QUEUE,
      delaySeconds: 0,
      remaining: 0,
    };
  }

  const requested = Math.max(0, Math.floor(suspend.delaySeconds));
  const thisHop = Math.min(requested, driverMaxSeconds);
  return { queue: DELAY_QUEUE, delaySeconds: thisHop, remaining: requested - thisHop };
}
