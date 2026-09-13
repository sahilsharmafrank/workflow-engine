import { PreFlightCheckActionOutcome, WorkflowStatus } from "./status";

export type WorkflowParameters = Record<string, unknown>;

export interface ParameterCaptureExpression {
  targetFieldName: string;
  modelEvaluationExpression: string;
}

export type WorkflowInputFieldType = "string" | "number" | "boolean" | "json";

export interface WorkflowInputField {
  name: string;
  type: WorkflowInputFieldType;
  required: boolean;
  description?: string;
}

export interface PreFlightCheckParameters {
  conditionsToCheck: ParameterCaptureExpression[];
  actionOnFailure: PreFlightCheckActionOutcome;
  failureMessage?: string;
}

/**
 * One step inside a workflow definition document.
 * `stepClassName` and `stepFileName` are accepted for backward compatibility with
 * definitions authored against the original engine. `stepFileName` is ignored;
 * `stepClassName` is treated as an alias for `stepType` when `stepType` is absent.
 */
export interface StepDefinition {
  stepName: string;
  stepVersion: string;
  stepType?: string;
  stepClassName?: string;
  stepFileName?: string;
  stepInputs: ParameterCaptureExpression[];
  stepOutputs?: ParameterCaptureExpression[];
  stepStateCapture?: ParameterCaptureExpression[];
  externalServiceName?: string;
  preFlightCheck?: PreFlightCheckParameters;
}

export interface WorkflowDefinitionBody {
  steps: StepDefinition[];
  inputSchema?: WorkflowInputField[];
}

export interface StepProgress {
  units?: string;
  totalExpected?: number;
  currentProgress?: number;
}

/** Plain shape of a persisted run. Core entities implement this. */
export interface WorkflowRunLike {
  id?: number;
  tenantId: string;
  definitionId?: number;
  name: string;
  version: string;
  currentStep: number;
  status: WorkflowStatus;
  inputs: WorkflowParameters;
  outputs: WorkflowParameters;
  state: WorkflowParameters;
  stepRuns?: StepRunLike[];
}

/** Plain shape of a persisted step. Core entities implement this. */
export interface StepRunLike {
  id?: number;
  stepNumber: number;
  stepName: string;
  stepType: string;
  status: WorkflowStatus;
  message?: string;
  inputs: WorkflowParameters;
  outputs: WorkflowParameters;
  state: WorkflowParameters;
  progress?: StepProgress;
  externalServiceName?: string;
  lastStepAction?: Date;
}

/** Resolves the effective step type, honouring the legacy alias. */
export function resolveStepType(step: StepDefinition): string {
  const type = step.stepType ?? step.stepClassName;
  if (!type) {
    throw new Error(`Step "${step.stepName}" declares neither stepType nor stepClassName`);
  }
  return type;
}
