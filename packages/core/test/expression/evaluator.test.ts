import { ExpressionEvaluator } from "../../src/expression/evaluator";
import { WfeError } from "../../src/errors";

describe("ExpressionEvaluator", () => {
  let evaluator: ExpressionEvaluator;

  beforeAll(() => {
    evaluator = new ExpressionEvaluator({ timeoutMs: 100 });
  });

  afterAll(() => evaluator.dispose());

  const scope = {
    workflowState: {
      inputs: { jobId: "abc-123", count: 2 },
      namedSteps: { Fetch: { outputs: { size: 10 } } },
    },
    config: { region: "us-west-2" },
    body: { callbackValue: 7 },
  };

  it("reads a value out of workflow inputs", async () => {
    await expect(evaluator.evaluate("workflowState.inputs.jobId", scope)).resolves.toBe("abc-123");
  });

  it("supports literal constructors used by existing definitions", async () => {
    await expect(evaluator.evaluate('String("published")', scope)).resolves.toBe("published");
    await expect(evaluator.evaluate("Number(0)", scope)).resolves.toBe(0);
  });

  it("supports arithmetic and Math", async () => {
    await expect(evaluator.evaluate("Math.max(workflowState.inputs.count, 5)", scope)).resolves.toBe(5);
  });

  it("reads config and callback body", async () => {
    await expect(evaluator.evaluate("config.region", scope)).resolves.toBe("us-west-2");
    await expect(evaluator.evaluate("body.callbackValue", scope)).resolves.toBe(7);
  });

  it("rewrites stepStates access to namedSteps", async () => {
    await expect(
      evaluator.evaluate("workflowState.stepStates.Fetch.outputs.size", scope)
    ).resolves.toBe(10);
  });

  it("returns objects and arrays by value", async () => {
    await expect(evaluator.evaluate("workflowState.inputs", scope)).resolves.toEqual({
      jobId: "abc-123",
      count: 2,
    });
  });

  describe("sandbox isolation", () => {
    // `require` is a CommonJS module-local binding, not a global — it is
    // unreachable from `new Function(...)` too, so a bare `require("fs")` test
    // would pass whether or not the sandbox actually isolates anything. `Buffer`
    // and `process`, by contrast, ARE real Node globals visible to code run via
    // `new Function(...)` in this process, so asserting they are unreachable here
    // is a differential test: it fails if the isolate is ever swapped back out
    // for `new Function`.
    it("has no Buffer (a Node global reachable from new Function, but not from the isolate)", async () => {
      await expect(evaluator.evaluate("Buffer.from('x')", scope)).rejects.toThrow(
        /Buffer is not defined/i
      );
    });

    it("has no process", async () => {
      await expect(evaluator.evaluate("process.env", scope)).rejects.toThrow(
        /process is not defined/i
      );
    });

    it("cannot reach the host through constructor walking", async () => {
      await expect(
        evaluator.evaluate('(function(){}).constructor("return process")()', scope)
      ).rejects.toThrow();
    });

    it("cannot pollute the host prototype chain", async () => {
      await evaluator
        .evaluate('(Object.prototype.polluted = "yes", 1)', scope)
        .catch(() => undefined);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("aborts an infinite loop at the timeout", async () => {
      // `while (true) {}` is a statement, not an expression — interpolated into
      // the evaluator's `return (${expr})` wrapper it is a SyntaxError that
      // `compileScript` rejects in ~1ms, never reaching `script.run(...)`, so it
      // would never actually exercise the timeout. Wrapping it in an IIFE puts it
      // in expression position so the loop really runs and is really killed by
      // the isolate's `timeout` option (the evaluator's only DoS control over
      // expressions sourced from database rows).
      const start = Date.now();
      await expect(
        evaluator.evaluate("(function(){ while(true){} })()", scope)
      ).rejects.toThrow(/timed out/i);
      const elapsed = Date.now() - start;
      // A SyntaxError or ReferenceError rejects in a few ms; only an actually-run
      // and actually-killed loop takes close to the configured 100ms timeout.
      expect(elapsed).toBeGreaterThanOrEqual(80);

      // The isolate must still be usable after a timeout fires — a timeout is
      // expected, recoverable behaviour, not isolate-ending damage.
      await expect(evaluator.evaluate("1 + 1", scope)).resolves.toBe(2);
    }, 10000);
  });

  it("throws a WfeError naming the failing expression", async () => {
    const expression = "workflowState.missing.deep";
    let caught: unknown;
    try {
      await evaluator.evaluate(expression, scope);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WfeError);
    const error = caught as WfeError;
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("EXPRESSION_EVALUATION_FAILED");
    expect(error.details).toEqual({ expression });
    expect(error.message).toMatch(/workflowState\.missing\.deep/);
  });
});
