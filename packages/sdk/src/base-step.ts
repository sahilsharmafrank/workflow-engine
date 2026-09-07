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
   * Called before `run` on **first entry** into the step, not on resumption.
   * Override for one-time setup — dispatching an external request, claiming a
   * resource. The default does nothing.
   */
  async start(_ctx: StepContext): Promise<void> {
    return;
  }

  abstract run(ctx: StepContext): Promise<RunStepResponse>;
}

export type StepFactory = (params: StepParams) => BaseStep;
