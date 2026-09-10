import { Chip } from "@mui/material";

type PillColor = "success" | "error" | "warning" | "info" | "default";

/**
 * Run and step statuses share a vocabulary (WorkflowStatus in @wfe/sdk). An
 * unknown value renders neutrally rather than throwing — a new engine status
 * should degrade, not break the screen.
 */
export function statusColor(status: string): PillColor {
  switch (status) {
    case "complete":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
    case "cancelling":
      return "warning";
    case "running":
    case "starting":
    case "waiting":
    case "paused":
      return "info";
    default:
      return "default";
  }
}

export function StatusPill({ status }: { status: string }) {
  return <Chip size="small" label={status} color={statusColor(status)} />;
}
