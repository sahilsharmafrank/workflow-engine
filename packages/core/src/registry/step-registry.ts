import { BaseStep, StepFactory, StepParams, WorkflowInputField } from "@wfe/sdk";
import { WfeError } from "../errors";
import { ConditionStep } from "../steps/condition-step";
import { DelayStep } from "../steps/delay-step";
import { EmitEventStep } from "../steps/emit-event-step";
import { HttpStep } from "../steps/http-step";
import { ExternalTaskStep } from "../steps/external-task-step";
import { NoopStep } from "../steps/noop-step";
import { SubWorkflowStep } from "../steps/sub-workflow-step";
import { TransformStep } from "../steps/transform-step";

export interface StepRegistration {
  type: string;
  version: string;
  factory: StepFactory;
  description?: string;
  /** Fields the step reads from `ctx.inputs`. Prototype: declared for core.http only. */
  inputSchema?: WorkflowInputField[];
  /** Fields the step writes to `ctx.step.outputs`. Prototype: declared for core.http only. */
  outputSchema?: WorkflowInputField[];
}

export class StepRegistry {
  private readonly registrations = new Map<string, StepRegistration>();

  register(registration: StepRegistration): void {
    if (this.registrations.has(registration.type)) {
      throw new WfeError(`Step type "${registration.type}" is already registered`, {
        statusCode: 409,
        code: "STEP_TYPE_DUPLICATE",
      });
    }
    this.registrations.set(registration.type, registration);
  }

  has(type: string): boolean {
    return this.registrations.has(type);
  }

  get(type: string): StepRegistration | undefined {
    return this.registrations.get(type);
  }

  create(type: string, params: StepParams): BaseStep {
    const registration = this.registrations.get(type);
    if (!registration) {
      throw new WfeError(
        `Unknown step type "${type}". Registered types: ${[...this.registrations.keys()].join(", ") || "none"}`,
        { statusCode: 400, code: "STEP_TYPE_UNKNOWN" }
      );
    }
    return registration.factory({ ...params, type });
  }

  list(): StepRegistration[] {
    return [...this.registrations.values()];
  }
}

export function registerBuiltInSteps(registry: StepRegistry): void {
  registry.register({
    type: "core.noop",
    version: "1.0.0",
    description: "Completes immediately without doing anything.",
    factory: (params) => new NoopStep(params),
  });
  registry.register({
    type: "core.transform",
    version: "1.0.0",
    description: "Writes its resolved inputs straight to its outputs.",
    factory: (params) => new TransformStep(params),
  });
  registry.register({
    type: "core.externalTask",
    version: "1.0.0",
    description: "Dispatches to an external service queue and waits for its callback.",
    factory: (params) => new ExternalTaskStep(params),
  });
  registry.register({
    type: "core.delay",
    version: "1.0.0",
    description: "Suspends the run for a number of seconds, then completes.",
    factory: (params) => new DelayStep(params),
  });
  registry.register({
    type: "core.condition",
    version: "1.0.0",
    description: "Evaluates a boolean condition; skips or fails when falsy.",
    factory: (params) => new ConditionStep(params),
  });
  registry.register({
    type: "core.emitEvent",
    version: "1.0.0",
    description: "Publishes a payload to a named queue.",
    factory: (params) => new EmitEventStep(params),
  });
  registry.register({
    type: "core.http",
    version: "1.0.0",
    description: "Makes an HTTP request with optional retry/backoff.",
    factory: (params) => new HttpStep(params),
    inputSchema: [
      { name: "url", type: "string", required: true },
      { name: "method", type: "string", required: false, description: "Defaults to GET" },
      { name: "headers", type: "json", required: false },
      { name: "body", type: "json", required: false },
      { name: "retries", type: "number", required: false, description: "Defaults to 0" },
      { name: "backoffMs", type: "number", required: false, description: "Defaults to 1000" },
      { name: "timeoutMs", type: "number", required: false, description: "Defaults to 30000" },
    ],
    outputSchema: [
      { name: "status", type: "number", required: true },
      { name: "headers", type: "json", required: true },
      { name: "body", type: "json", required: true },
    ],
  });
  registry.register({
    type: "core.subWorkflow",
    version: "1.0.0",
    description: "Starts a child workflow run (fire-and-forget).",
    factory: (params) => new SubWorkflowStep(params),
  });
}
