import { StepRegistry, registerBuiltInSteps } from "../../src/registry/step-registry";
import { validateAgainstRegistry, validateDefinitionShape, validateRunInputs } from "../../src/registry/validate";
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

  it("rejects duplicate input names, which would break run-input addressing", async () => {
    const parsed = await validateDefinitionShape({
      steps: [{ stepName: "Only", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
      inputSchema: [
        { name: "jobId", type: "string", required: true },
        { name: "jobId", type: "string", required: false },
      ],
    });
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    expect(() => validateAgainstRegistry(parsed, registry)).toThrow(/jobId/);
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

describe("input schema shape validation", () => {
  it("accepts a definition whose inputSchema declares valid fields", async () => {
    const body = {
      steps: [{ stepName: "A", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
      inputSchema: [
        { name: "jobId", type: "string", required: true },
        { name: "dryRun", type: "boolean", required: false, description: "Skip side effects" },
      ],
    };
    await expect(validateDefinitionShape(body)).resolves.toMatchObject({
      inputSchema: [
        { name: "jobId", type: "string", required: true },
        { name: "dryRun", type: "boolean", required: false },
      ],
    });
  });

  it("rejects an inputSchema field with an unknown type", async () => {
    const body = {
      steps: [{ stepName: "A", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
      inputSchema: [{ name: "jobId", type: "uuid", required: true }],
    };
    await expect(validateDefinitionShape(body)).rejects.toThrow();
  });

  it("rejects an inputSchema field missing its name", async () => {
    const body = {
      steps: [{ stepName: "A", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
      inputSchema: [{ type: "string", required: true }],
    };
    await expect(validateDefinitionShape(body)).rejects.toThrow();
  });

  it("accepts a definition with no inputSchema at all", async () => {
    const body = {
      steps: [{ stepName: "A", stepVersion: "1.0.0", stepType: "core.noop", stepInputs: [] }],
    };
    const parsed = await validateDefinitionShape(body);
    expect(parsed.inputSchema).toBeUndefined();
  });
});

describe("validateRunInputs", () => {
  const withSchema = {
    steps: [],
    inputSchema: [
      { name: "jobId", type: "string" as const, required: true },
      { name: "note", type: "string" as const, required: false },
    ],
  };

  it("does nothing when every required field is present", () => {
    expect(() => validateRunInputs(withSchema, { jobId: "j-1" })).not.toThrow();
  });

  it("allows extra inputs not named in the schema", () => {
    expect(() => validateRunInputs(withSchema, { jobId: "j-1", extra: 42 })).not.toThrow();
  });

  it("throws a WfeError listing every missing required field", () => {
    const twoRequired = {
      steps: [],
      inputSchema: [
        { name: "jobId", type: "string" as const, required: true },
        { name: "region", type: "string" as const, required: true },
      ],
    };
    try {
      validateRunInputs(twoRequired, {});
      fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WfeError);
      const wfeErr = err as WfeError;
      expect(wfeErr.statusCode).toBe(400);
      expect(wfeErr.code).toBe("RUN_INPUT_MISSING");
      expect(wfeErr.details).toEqual([
        { path: "jobId", message: "jobId is required" },
        { path: "region", message: "region is required" },
      ]);
    }
  });

  it("is a no-op when the definition declares no inputSchema", () => {
    expect(() => validateRunInputs({ steps: [] }, {})).not.toThrow();
  });
});
