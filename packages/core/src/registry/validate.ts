import { PreFlightCheckActionOutcome, WorkflowDefinitionBody, resolveStepType } from "@wfe/sdk";
import { array, mixed, object, string, ValidationError } from "yup";
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

const definitionSchema = object({
  steps: array().of(stepSchema).min(1).required(),
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
