import ivm from "isolated-vm";
import { WfeError } from "../errors";

export interface EvaluationScope {
  workflowState: unknown;
  config?: unknown;
  body?: unknown;
}

export interface EvaluatorOptions {
  timeoutMs?: number;
  memoryLimitMb?: number;
}

const DEFAULT_TIMEOUT_MS = 100;
const DEFAULT_MEMORY_MB = 32;

/**
 * Evaluates workflow capture expressions inside an isolate. The isolate has no
 * Node globals at all — no require, no process, no filesystem — so the only
 * reachable data is what this class copies in.
 */
export class ExpressionEvaluator {
  private readonly isolate: ivm.Isolate;
  private readonly timeoutMs: number;

  constructor(options: EvaluatorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.isolate = new ivm.Isolate({ memoryLimit: options.memoryLimitMb ?? DEFAULT_MEMORY_MB });
  }

  /** Preserves the original engine's step-name addressing rewrite. */
  private static rewrite(expression: string): string {
    return expression.replace(/workflowState\.stepStates\./g, "workflowState.namedSteps.");
  }

  async evaluate(expression: string, scope: EvaluationScope): Promise<unknown> {
    const context = await this.isolate.createContext();
    try {
      const jail = context.global;
      await jail.set("__workflowState", new ivm.ExternalCopy(scope.workflowState ?? {}).copyInto());
      await jail.set("__config", new ivm.ExternalCopy(scope.config ?? {}).copyInto());
      await jail.set("__body", new ivm.ExternalCopy(scope.body ?? undefined).copyInto());

      const source = `(function (workflowState, config, body) { return (${ExpressionEvaluator.rewrite(
        expression
      )}); })(__workflowState, __config, __body)`;

      const script = await this.isolate.compileScript(source);
      return await script.run(context, { timeout: this.timeoutMs, copy: true });
    } catch (err) {
      throw new WfeError(
        `Failed evaluating expression "${expression}": ${(err as Error).message}`,
        { statusCode: 400, code: "EXPRESSION_EVALUATION_FAILED", details: { expression } }
      );
    } finally {
      context.release();
    }
  }

  dispose(): void {
    this.isolate.dispose();
  }
}
