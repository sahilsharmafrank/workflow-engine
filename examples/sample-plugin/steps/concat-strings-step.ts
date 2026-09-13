import { BaseStep, WorkflowStatus } from "@wfe/sdk";
import type { RunStepResponse, StepContext } from "@wfe/sdk";

/**
 * Concatenates two strings with a delimiter. The transform logic lives here,
 * in code — the definition's stepInputs only wire values in, they don't
 * compute anything.
 */
export class ConcatStringsStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    const { str1, str2, delimiter = " " } = ctx.inputs as {
      str1: string;
      str2: string;
      delimiter?: string;
    };
    if (typeof str1 !== "string" || typeof str2 !== "string") {
      throw new Error("demo.concatStrings requires string inputs str1 and str2");
    }
    ctx.step.outputs = { combined: `${str1}${delimiter}${str2}` };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
