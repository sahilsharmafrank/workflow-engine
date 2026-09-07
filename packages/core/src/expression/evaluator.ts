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
  // Lazily created (and re-created) rather than built once in the constructor:
  // isolated-vm *disposes* an isolate outright when it exceeds its memory
  // limit — it does not just fail the one script — so a single oversized
  // expression would otherwise permanently kill every later evaluate() call
  // for the lifetime of this instance. See ensureIsolate().
  private isolate?: ivm.Isolate;
  private readonly timeoutMs: number;
  private readonly memoryLimitMb: number;

  constructor(options: EvaluatorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.memoryLimitMb = options.memoryLimitMb ?? DEFAULT_MEMORY_MB;
  }

  /** Creates the isolate on first use, and transparently replaces it if a prior
   * call caused isolated-vm to dispose it (e.g. a memory-limit violation). */
  private ensureIsolate(): ivm.Isolate {
    if (!this.isolate || this.isolate.isDisposed) {
      this.isolate = new ivm.Isolate({ memoryLimit: this.memoryLimitMb });
    }
    return this.isolate;
  }

  /** Preserves the original engine's step-name addressing rewrite. */
  private static rewrite(expression: string): string {
    return expression.replace(/workflowState\.stepStates\./g, "workflowState.namedSteps.");
  }

  /**
   * Classifies the failure so a resource-exhaustion timeout, a malformed stored
   * expression, and an ordinary runtime error (e.g. a missing property) are
   * distinguishable in logs rather than all collapsing into one generic code.
   */
  private static classify(err: unknown): { code: string; cause: Error } {
    const cause = err instanceof Error ? err : new Error(String(err));
    if (/timed out/i.test(cause.message)) {
      return { code: "EXPRESSION_TIMEOUT", cause };
    }
    if (cause.name === "SyntaxError") {
      return { code: "EXPRESSION_SYNTAX_ERROR", cause };
    }
    return { code: "EXPRESSION_EVALUATION_FAILED", cause };
  }

  async evaluate(expression: string, scope: EvaluationScope): Promise<unknown> {
    const isolate = this.ensureIsolate();
    const context = await isolate.createContext();
    let script: ivm.Script | undefined;
    try {
      const jail = context.global;
      await jail.set(
        "__workflowState",
        new ivm.ExternalCopy(scope.workflowState ?? {}).copyInto({ release: true })
      );
      await jail.set("__config", new ivm.ExternalCopy(scope.config ?? {}).copyInto({ release: true }));
      await jail.set("__body", new ivm.ExternalCopy(scope.body ?? undefined).copyInto({ release: true }));

      const source = `(function (workflowState, config, body) { return (${ExpressionEvaluator.rewrite(
        expression
      )}); })(__workflowState, __config, __body)`;

      script = await isolate.compileScript(source);
      return await script.run(context, { timeout: this.timeoutMs, copy: true });
    } catch (err) {
      const { code, cause } = ExpressionEvaluator.classify(err);
      throw new WfeError(`Failed evaluating expression "${expression}": ${cause.message}`, {
        statusCode: 400,
        code,
        details: { expression },
        cause,
      });
    } finally {
      script?.release();
      context.release();
    }
  }

  dispose(): void {
    if (this.isolate && !this.isolate.isDisposed) {
      this.isolate.dispose();
    }
    this.isolate = undefined;
  }
}
