import { StepRunLike, WorkflowRunLike, WorkflowStatus } from "@wfe/sdk";
import { toPlainSnapshot } from "../../src/expression/snapshot";

/**
 * Stands in for a real ORM/entity instance: a class with a prototype and a
 * method, plus a `Date` field, the way a persisted step run would arrive from
 * the database layer before `toPlainSnapshot` gets to it.
 */
class FakeStepEntity implements StepRunLike {
  stepNumber = 1;
  stepName = "Fetch";
  stepType = "http";
  status = WorkflowStatus.COMPLETE;
  inputs = {};
  outputs = { size: 10 };
  state = {};
  lastStepAction = new Date("2024-01-01T00:00:00.000Z");

  leaks(): string {
    return "leak";
  }
}

function baseRun(): WorkflowRunLike {
  return {
    tenantId: "tenant-1",
    name: "demo",
    version: "1",
    currentStep: 0,
    status: WorkflowStatus.RUNNING,
    inputs: { startedAt: new Date("2024-06-01T12:00:00.000Z") },
    outputs: {},
    state: {},
  };
}

describe("toPlainSnapshot", () => {
  it("converts Date values to ISO strings via the JSON round-trip", () => {
    const plain = toPlainSnapshot(baseRun());
    expect(plain.inputs).toEqual({ startedAt: "2024-06-01T12:00:00.000Z" });
  });

  it("builds namedSteps keyed by stepName", () => {
    const run: WorkflowRunLike = { ...baseRun(), stepRuns: [new FakeStepEntity()] };
    const plain = toPlainSnapshot(run);
    expect(Object.keys(plain.namedSteps)).toEqual(["Fetch"]);
    expect(plain.namedSteps.Fetch).toMatchObject({
      stepName: "Fetch",
      outputs: { size: 10 },
      lastStepAction: "2024-01-01T00:00:00.000Z",
    });
  });

  it("exposes stepStates equal to the step array", () => {
    const run: WorkflowRunLike = { ...baseRun(), stepRuns: [new FakeStepEntity()] };
    const plain = toPlainSnapshot(run);
    expect(plain.stepStates).toEqual(plain.stepRuns);
  });

  it("skips a step with no stepName when building namedSteps", () => {
    const unnamed: StepRunLike = { ...new FakeStepEntity(), stepName: "" };
    const run: WorkflowRunLike = { ...baseRun(), stepRuns: [unnamed] };
    const plain = toPlainSnapshot(run);
    expect(plain.namedSteps).toEqual({});
  });

  it("strips class prototypes and methods from steps during the round-trip", () => {
    const step = new FakeStepEntity();
    expect(typeof step.leaks).toBe("function");
    expect(Object.getPrototypeOf(step)).not.toBe(Object.prototype);

    const run: WorkflowRunLike = { ...baseRun(), stepRuns: [step] };
    const plain = toPlainSnapshot(run);
    const plainStep = plain.namedSteps.Fetch as Record<string, unknown>;

    expect(Object.getPrototypeOf(plainStep)).toBe(Object.prototype);
    expect(plainStep.leaks).toBeUndefined();
  });
});
