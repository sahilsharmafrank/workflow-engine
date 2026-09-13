import { PreFlightCheckActionOutcome, WorkflowDefinitionBody, WorkflowParameters, resolveStepType } from "@wfe/sdk";
import { array, boolean, mixed, object, string, ValidationError } from "yup";
import { WfeError } from "../errors";
import { StepRegistry } from "./step-registry";

const captureExpressionSchema = object({
  targetFieldName: string().required(),
  modelEvaluationExpression: string().required(),
});

const stepSchema = object({
  stepName: string().min(1).max(200).required(),
  stepVersion: string().min(1).max(20).required(),
  stepType: string().optional(),
  stepClassName: string().optional(),
  stepFileName: string().optional(),
  stepInputs: array().of(captureExpressionSchema).required(),
  stepOutputs: array().of(captureExpressionSchema).optional(),
  stepStateCapture: array().of(captureExpressionSchema).optional(),
  externalServiceName: string().optional(),
  preFlightCheck: object({
    conditionsToCheck: array().of(captureExpressionSchema).required(),
    actionOnFailure: mixed<PreFlightCheckActionOutcome>()
      .oneOf(Object.values(PreFlightCheckActionOutcome))
      .required(),
    failureMessage: string().optional(),
  }).default(undefined),
});

const inputFieldSchema = object({
  name: string().min(1).required(),
  type: mixed<"string" | "number" | "boolean" | "json">()
    .oneOf(["string", "number", "boolean", "json"])
    .required(),
  required: boolean().required(),
  description: string().optional(),
});

const definitionSchema = object({
  steps: array().of(stepSchema).min(1).required(),
  inputSchema: array().of(inputFieldSchema).optional(),
});

export async function validateDefinitionShape(body: unknown): Promise<WorkflowDefinitionBody> {
  try {
    return (await definitionSchema.validate(body, { abortEarly: false, stripUnknown: false })) as WorkflowDefinitionBody;
  } catch (err) {
    const validationError = err as ValidationError;
    const details = validationError.inner?.map((e) => ({
      path: e.path,
      message: e.message,
    }));
    throw new WfeError(`Invalid workflow definition: ${(err as Error).message}`, {
      statusCode: 400,
      code: "DEFINITION_INVALID",
      details,
    });
  }
}

/** Rejects a definition that names an unregistered step type or reuses a step name. */
export function validateAgainstRegistry(body: WorkflowDefinitionBody, registry: StepRegistry): void {
  const seenInputNames = new Set<string>();
  for (const field of body.inputSchema ?? []) {
    if (seenInputNames.has(field.name)) {
      throw new WfeError(
        `Duplicate input name "${field.name}" — input names must be unique`,
        { statusCode: 400, code: "DEFINITION_DUPLICATE_INPUT_NAME" }
      );
    }
    seenInputNames.add(field.name);
  }

  const seen = new Set<string>();
  for (const step of body.steps) {
    if (seen.has(step.stepName)) {
      throw new WfeError(
        `Duplicate step name "${step.stepName}" — step names must be unique so expressions can address steps by name`,
        { statusCode: 400, code: "DEFINITION_DUPLICATE_STEP_NAME" }
      );
    }
    seen.add(step.stepName);

    let type: string;
    try {
      type = resolveStepType(step);
    } catch (err) {
      throw new WfeError(
        `Step "${step.stepName}" has no stepType or stepClassName`,
        { statusCode: 400, code: "DEFINITION_MISSING_STEP_TYPE" }
      );
    }

    if (!registry.has(type)) {
      throw new WfeError(
        `Step "${step.stepName}" references unregistered step type "${type}"`,
        { statusCode: 400, code: "DEFINITION_UNKNOWN_STEP_TYPE" }
      );
    }
  }
}

/**
 * Rejects a run start that omits a required input declared in the
 * definition's inputSchema. Presence-only: a provided value's type is never
 * checked against the declared type (design doc §3, §5).
 */
export function validateRunInputs(
  definition: WorkflowDefinitionBody, inputs: WorkflowParameters
): void {
  const missing = (definition.inputSchema ?? [])
    .filter((field) => field.required && !(field.name in inputs))
    .map((field) => ({ path: field.name, message: `${field.name} is required` }));

  if (missing.length > 0) {
    throw new WfeError(
      `Missing required input(s): ${missing.map((m) => m.path).join(", ")}`,
      { statusCode: 400, code: "RUN_INPUT_MISSING", details: missing }
    );
  }
}
