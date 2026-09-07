import { WorkflowStatus } from "@wfe/sdk";
import { captureParameters } from "../../src/expression/capture";
import { ExpressionEvaluator } from "../../src/expression/evaluator";

const run = {
  tenantId: "default",
  name: "test",
  version: "1.0.0",
  currentStep: 1,
  status: WorkflowStatus.RUNNING,
  inputs: { jobId: "j-1", retries: 3 },
  outputs: {},
  state: { region: "eu" },
  stepRuns: [
    {
      stepNumber: 0,
      stepName: "Fetch",
      stepType: "core.noop",
      status: WorkflowStatus.COMPLETE,
      inputs: {},
      outputs: { size: 42 },
      state: {},
    },
  ],
};

describe("captureParameters", () => {
  let evaluator: ExpressionEvaluator;
  beforeAll(() => (evaluator = new ExpressionEvaluator({ timeoutMs: 200 })));
  afterAll(() => evaluator.dispose());

  it("maps each expression onto its target field", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "jobId", modelEvaluationExpression: "workflowState.inputs.jobId" },
        { targetFieldName: "label", modelEvaluationExpression: 'String("ready")' },
      ],
    });
    expect(params).toEqual({ jobId: "j-1", label: "ready" });
  });

  it("expands dotted target field names into nested objects", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "opts.retries", modelEvaluationExpression: "workflowState.inputs.retries" },
        { targetFieldName: "opts.region", modelEvaluationExpression: "workflowState.state.region" },
      ],
    });
    expect(params).toEqual({ opts: { retries: 3, region: "eu" } });
  });

  it("resolves prior step outputs by step name", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "size", modelEvaluationExpression: "workflowState.stepStates.Fetch.outputs.size" },
      ],
    });
    expect(params).toEqual({ size: 42 });
  });

  it("does not let an empty object clobber a populated value", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "opts", modelEvaluationExpression: "({ a: 1 })" },
        { targetFieldName: "opts", modelEvaluationExpression: "({})" },
      ],
    });
    expect(params).toEqual({ opts: { a: 1 } });
  });

  it("preserves scalar when empty object is merged later at same field", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "timeout", modelEvaluationExpression: "5" },
        { targetFieldName: "timeout", modelEvaluationExpression: "({})" },
      ],
    });
    expect(params).toEqual({ timeout: 5 });
  });

  it("allows 0 to overwrite populated value in same field", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "value", modelEvaluationExpression: "42" },
        { targetFieldName: "value", modelEvaluationExpression: "0" },
      ],
    });
    expect(params).toEqual({ value: 0 });
  });

  it("allows empty string to overwrite populated value in same field", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "label", modelEvaluationExpression: '"initial"' },
        { targetFieldName: "label", modelEvaluationExpression: '""' },
      ],
    });
    expect(params).toEqual({ label: "" });
  });

  it("allows false to overwrite populated value in same field", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      expressions: [
        { targetFieldName: "enabled", modelEvaluationExpression: "true" },
        { targetFieldName: "enabled", modelEvaluationExpression: "false" },
      ],
    });
    expect(params).toEqual({ enabled: false });
  });

  it("passes config and body through to expressions", async () => {
    const params = await captureParameters({
      evaluator,
      run,
      config: { bucket: "b1" },
      body: { token: "t1" },
      expressions: [
        { targetFieldName: "bucket", modelEvaluationExpression: "config.bucket" },
        { targetFieldName: "token", modelEvaluationExpression: "body.token" },
      ],
    });
    expect(params).toEqual({ bucket: "b1", token: "t1" });
  });

  it("returns an empty object for an empty expression list", async () => {
    await expect(captureParameters({ evaluator, run, expressions: [] })).resolves.toEqual({});
  });

  it("propagates the evaluation failure with the expression named", async () => {
    await expect(
      captureParameters({
        evaluator,
        run,
        expressions: [{ targetFieldName: "x", modelEvaluationExpression: "workflowState.nope.deep" }],
      })
    ).rejects.toThrow(/workflowState\.nope\.deep/);
  });
});
