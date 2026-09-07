import { ParameterCaptureExpression, WorkflowParameters, WorkflowRunLike } from "@wfe/sdk";
import { isEmpty, isObject, mergeWith, set } from "lodash";
import { ExpressionEvaluator } from "./evaluator";
import { toPlainSnapshot } from "./snapshot";

export interface CaptureOptions {
  evaluator: ExpressionEvaluator;
  run: WorkflowRunLike;
  expressions: ParameterCaptureExpression[];
  config?: Record<string, unknown>;
  body?: unknown;
}

/**
 * Evaluates a list of capture expressions against a run and merges the results
 * into one parameter object. Port of the original `captureFromModelConfigAndBody`.
 */
export async function captureParameters(opts: CaptureOptions): Promise<WorkflowParameters> {
  const { evaluator, run, expressions, config = {}, body } = opts;
  if (expressions.length === 0) {
    return {};
  }

  const workflowState = toPlainSnapshot(run);

  const captured: Array<Record<string, unknown>> = [];
  for (const { targetFieldName, modelEvaluationExpression } of expressions) {
    const value = await evaluator.evaluate(modelEvaluationExpression, {
      workflowState,
      config,
      body,
    });
    captured.push(set({}, targetFieldName, value));
  }

  // Keeps the left-hand value when the right-hand one is an empty object, so a
  // later expression yielding {} cannot erase an earlier populated result.
  const keepPopulated = (objValue: unknown, srcValue: unknown): unknown =>
    isObject(srcValue) && isEmpty(srcValue) ? objValue : undefined;

  return mergeWith({}, ...captured, keepPopulated) as WorkflowParameters;
}
