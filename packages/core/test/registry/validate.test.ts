import { StepRegistry, registerBuiltInSteps } from "../../src/registry/step-registry";
import { validateAgainstRegistry, validateDefinitionShape } from "../../src/registry/validate";
import { WfeError } from "../../src/errors";

const valid = {
  steps: [
    {
      stepName: "Prepare",
      stepVersion: "1.0.0",
      stepType: "core.transform",
      stepInputs: [{ targetFieldName: "jobId", modelEvaluationExpression: "workflowState.inputs.jobId" }],
    },
  ],
};

describe("definition validation", () => {
  it("accepts a well-formed definition", async () => {
    await expect(validateDefinitionShape(valid)).resolves.toMatchObject({ steps: expect.any(Array) });
  });

  it("rejects a definition with no steps array", async () => {
    await expect(validateDefinitionShape({})).rejects.toThrow();
  });

  it("rejects a step missing its inputs array", async () => {
    await expect(
      validateDefinitionShape({ steps: [{ stepName: "A", stepVersion: "1.0.0", stepType: "core.noop" }] })
    ).rejects.toThrow();
  });

  it("accepts the legacy stepClassName alias", async () => {
    const legacy = {
      steps: [
        { stepName: "Prepare", stepVersion: "1.0.0", stepClassName: "core.transform",
          stepFileName: "ignored", stepInputs: [] },
      ],
    };
    const parsed = await validateDefinitionShape(legacy);
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    expect(() => validateAgainstRegistry(parsed, registry)).not.toThrow();
  });

  it("rejects a step type that is not registered", async () => {
    const parsed = await validateDefinitionShape({
      steps: [{ stepName: "Ghost", stepVersion: "1.0.0", stepType: "vendor.ghost", stepInputs: [] }],
    });
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    expect(() => validateAgainstRegistry(parsed, registry)).toThrow(/vendor\.ghost/);
  });

  it("rejects duplicate step names, which would break name-based addressing", async () => {
    const parsed = await validateDefinitionShape({
      steps: [
        { stepName: "Same", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
        { stepName: "Same", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] },
      ],
    });
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    expect(() => validateAgainstRegistry(parsed, registry)).toThrow(/Same/);
  });

  it("rejects a step missing both stepType and stepClassName with a WfeError", async () => {
    const parsed = await validateDefinitionShape({
      steps: [{ stepName: "NoType", stepVersion: "1.0.0", stepInputs: [] }],
    });
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    try {
      validateAgainstRegistry(parsed, registry);
      fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WfeError);
      const wfeErr = err as WfeError;
      expect(wfeErr.statusCode).toBe(400);
      expect(wfeErr.code).toBe("DEFINITION_MISSING_STEP_TYPE");
      expect(wfeErr.message).toMatch(/NoType/);
    }
  });

  it("reports detailed per-field errors when shape validation finds multiple problems", async () => {
    try {
      await validateDefinitionShape({
        steps: [
          {
            stepName: "", // empty name fails min(1)
            // stepVersion missing entirely
            stepInputs: "not an array", // type mismatch
          },
        ],
      });
      fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WfeError);
      const wfeErr = err as WfeError;
      expect(wfeErr.statusCode).toBe(400);
      expect(wfeErr.code).toBe("DEFINITION_INVALID");
      // With abortEarly: false, yup collects all errors into details
      expect(wfeErr.details).toBeDefined();
      expect(Array.isArray(wfeErr.details)).toBe(true);
      expect((wfeErr.details as Array<any>).length).toBeGreaterThanOrEqual(3);
    }
  });
});
