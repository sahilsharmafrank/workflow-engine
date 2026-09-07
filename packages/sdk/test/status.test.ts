import { WorkflowStatus, isTerminalStatus, isResumeBlocked } from "../src";

describe("status predicates", () => {
  it("treats complete, failed and cancelled as terminal", () => {
    expect(isTerminalStatus(WorkflowStatus.COMPLETE)).toBe(true);
    expect(isTerminalStatus(WorkflowStatus.FAILED)).toBe(true);
    expect(isTerminalStatus(WorkflowStatus.CANCELLED)).toBe(true);
  });

  it("does not treat running or waiting as terminal", () => {
    expect(isTerminalStatus(WorkflowStatus.RUNNING)).toBe(false);
    expect(isTerminalStatus(WorkflowStatus.WAITING)).toBe(false);
  });

  it("blocks resumption for cancelling and paused as well as terminal states", () => {
    expect(isResumeBlocked(WorkflowStatus.CANCELLING)).toBe(true);
    expect(isResumeBlocked(WorkflowStatus.PAUSED)).toBe(true);
    expect(isResumeBlocked(WorkflowStatus.CANCELLED)).toBe(true);
    expect(isResumeBlocked(WorkflowStatus.COMPLETE)).toBe(true);
    expect(isResumeBlocked(WorkflowStatus.RUNNING)).toBe(false);
  });
});
