import { BaseStep, WorkflowStatus } from "@wfe/sdk";
import type { RunStepResponse, StepContext } from "@wfe/sdk";

/** Converts a string to camelCase, splitting on any run of non-alphanumerics. */
export class CamelCaseStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    const { text } = ctx.inputs as { text: string };
    if (typeof text !== "string") {
      throw new Error("demo.camelCase requires a string input named text");
    }
    const words = text.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0);
    const camelCased = words
      .map((w, i) => {
        const lower = w.toLowerCase();
        return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join("");
    ctx.step.outputs = { camelCased };
    ctx.step.status = WorkflowStatus.COMPLETE;
    return { stepState: ctx.step };
  }
}
