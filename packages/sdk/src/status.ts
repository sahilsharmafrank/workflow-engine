export enum WorkflowStatus {
  NEW = "new",
  STARTING = "starting",
  RUNNING = "running",
  WAITING = "waiting",
  COMPLETE = "complete",
  FAILED = "failed",
  CANCELLING = "cancelling",
  CANCELLED = "cancelled",
  PAUSED = "paused",
  SKIPPED = "skipped",
}

export enum WorkflowDefinitionStatus {
  DRAFT = "draft",
  PUBLISHED = "published",
  ARCHIVED = "archived",
}

export enum PreFlightCheckActionOutcome {
  CONTINUE = "continue",
  SKIP = "skip",
  FAIL = "fail",
}

const TERMINAL: ReadonlySet<WorkflowStatus> = new Set([
  WorkflowStatus.COMPLETE,
  WorkflowStatus.FAILED,
  WorkflowStatus.CANCELLED,
]);

const RESUME_BLOCKED: ReadonlySet<WorkflowStatus> = new Set([
  ...TERMINAL,
  WorkflowStatus.CANCELLING,
  WorkflowStatus.PAUSED,
]);

export function isTerminalStatus(status: WorkflowStatus): boolean {
  return TERMINAL.has(status);
}

export function isResumeBlocked(status: WorkflowStatus): boolean {
  return RESUME_BLOCKED.has(status);
}
