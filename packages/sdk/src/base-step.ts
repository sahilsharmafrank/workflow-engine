import { RunStepResponse, StepContext } from "./step-context";

export interface StepParams {
  name: string;
  version: string;
  type: string;
}

export abstract class BaseStep {
  readonly name: string;
  readonly version: string;
  readonly type: string;

  constructor(params: StepParams) {
    this.name = params.name;
    this.version = params.version;
    this.type = params.type;
  }

  /**
   * Optional hook run after the declarative pre-flight check passes and before
   * `run`. Override for step-specific setup; the default does nothing.
   */
  async onBeforeRun(_ctx: StepContext): Promise<void> {
    return;
  }

  abstract run(ctx: StepContext): Promise<RunStepResponse>;
}

export type StepFactory = (params: StepParams) => BaseStep;
