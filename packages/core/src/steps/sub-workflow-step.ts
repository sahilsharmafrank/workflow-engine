import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { WfeError } from "../errors";

export class SubWorkflowStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    if (!ctx.startChildWorkflow) {
      throw new WfeError("core.subWorkflow requires the startChildWorkflow callback on StepContext", {
        statusCode: 500,
        code: "SUB_WORKFLOW_NOT_AVAILABLE",
      });
    }

    const { name, version, inputs } = ctx.inputs as {
      name: string;
      version: string;
      inputs: Record<string, unknown>;
    };

    const childRunId = await ctx.startChildWorkflow({ name, version, inputs: inputs ?? {} });

    ctx.step.outputs = { childRunId };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
