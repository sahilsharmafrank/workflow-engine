import { StepRunLike, WorkflowRunLike } from "@wfe/sdk";

export interface PlainRun {
  [key: string]: unknown;
  namedSteps: Record<string, unknown>;
}

/**
 * Produces a plain, structured-clonable snapshot of a run for the sandbox, with
 * `namedSteps` added so expressions can address steps by name.
 *
 * The JSON round-trip is deliberate: it strips entity prototypes, getters and
 * functions so nothing from the host can leak into the isolate. Dates become ISO
 * strings as a consequence.
 */
export function toPlainSnapshot(run: WorkflowRunLike): PlainRun {
  const plain = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
  const namedSteps: Record<string, unknown> = {};
  const steps: StepRunLike[] = (plain.stepRuns as StepRunLike[]) ?? [];
  for (const step of steps) {
    if (step.stepName) {
      namedSteps[step.stepName] = step;
    }
  }
  return { ...plain, stepStates: steps, namedSteps };
}
