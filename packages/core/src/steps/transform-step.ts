import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";

/**
 * Pure state reshape: whatever the step's capture expressions resolved to becomes
 * the step's outputs, so a definition can move and rename values with no code.
 */
export class TransformStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    ctx.step.outputs = { ...ctx.inputs };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
