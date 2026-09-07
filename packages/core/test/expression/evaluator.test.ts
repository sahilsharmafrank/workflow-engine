import { ExpressionEvaluator } from "../../src/expression/evaluator";

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
    it("has no require", async () => {
      await expect(evaluator.evaluate('require("fs")', scope)).rejects.toThrow();
    });

    it("has no process", async () => {
      await expect(evaluator.evaluate("process.env", scope)).rejects.toThrow();
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
      await expect(evaluator.evaluate("while (true) {}", scope)).rejects.toThrow();
    }, 10000);
  });

  it("throws a WfeError naming the failing expression", async () => {
    await expect(evaluator.evaluate("workflowState.missing.deep", scope)).rejects.toThrow(
      /workflowState\.missing\.deep/
    );
  });
});
