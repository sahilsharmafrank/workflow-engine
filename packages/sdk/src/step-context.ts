import { Logger } from "./logger";
import { StepRunLike, WorkflowParameters, WorkflowRunLike } from "./types";

/**
 * Everything a step is allowed to see. `services` is the injection seam that
 * replaces the original engine's bag of domain API clients: callers register
 * their own clients when constructing the engine, steps retrieve them by name.
 */
export interface StepContext {
  config: Readonly<Record<string, unknown>>;
  logger: Logger;
  services: Readonly<Record<string, unknown>>;
  run: WorkflowRunLike;
  step: StepRunLike;
  stepNumber: number;
  /** Inputs already resolved from the step's capture expressions. */
  inputs: WorkflowParameters;
  /** Payload supplied by an external callback resuming this step, if any. */
  body?: unknown;
}

export interface RunStepResponse {
  stepState: StepRunLike;
  /** When set, the executor suspends the run and resumes this step later. */
  delaySeconds?: number;
}
