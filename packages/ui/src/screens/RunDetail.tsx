import {
  Accordion, AccordionDetails, AccordionSummary, Button, CircularProgress,
  Paper, Stack, Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Link as RouterLink, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useCancelRun, useRestartRunFromStep, useRun } from "../api/hooks/useRuns";
import { ErrorState, NotFoundState } from "../components/ErrorState";
import { JsonView } from "../components/JsonView";
import { StatusPill } from "../components/StatusPill";

export function RunDetail() {
  const { id } = useParams();
  const runId = Number(id);
  const { data: run, isLoading, error } = useRun(runId);
  const cancel = useCancelRun();
  const restart = useRestartRunFromStep();

  if (isLoading) return <CircularProgress />;
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState message={error.message} />;
  }
  if (error) return <ErrorState error={error} />;
  if (!run) return null;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="h5">
          Run {run.id} — {run.name} {run.version}
        </Typography>
        <StatusPill status={run.status} />
        <Button variant="outlined" onClick={() => cancel.mutate(run.id)} disabled={cancel.isPending}>
          Cancel run
        </Button>
      </Stack>

      {/* Sub-workflow lineage, added to workflow_run in Phase 4. */}
      {run.parentRunId != null && (
        <Typography variant="body2">
          Child of <RouterLink to={`/runs/${run.parentRunId}`}>run {run.parentRunId}</RouterLink>
          {run.depth ? ` (depth ${run.depth})` : ""}
        </Typography>
      )}

      {cancel.error && <ErrorState error={cancel.error} />}
      {restart.error && <ErrorState error={restart.error} />}

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={3}>
          <JsonView label="Inputs" value={run.inputs} />
          <JsonView label="Outputs" value={run.outputs} />
          <JsonView label="State" value={run.state} />
        </Stack>
      </Paper>

      <Typography variant="h6">Steps</Typography>
      {run.stepRuns.map((step) => (
        <Accordion key={step.id} defaultExpanded={step.status === "failed"}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Stack direction="row" spacing={2} alignItems="center" sx={{ width: "100%" }}>
              <Typography sx={{ minWidth: 24 }}>{step.stepNumber}</Typography>
              <Typography sx={{ minWidth: 160 }}>{step.stepName}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
                {step.stepType}
              </Typography>
              <StatusPill status={step.status} />
              {step.message && (
                <Typography variant="body2" color="error">
                  {step.message}
                </Typography>
              )}
            </Stack>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={2}>
              <Stack direction="row" spacing={3}>
                <JsonView label="Inputs" value={step.inputs} />
                <JsonView label="Outputs" value={step.outputs} />
                <JsonView label="State" value={step.state} />
              </Stack>
              <Button
                size="small"
                variant="outlined"
                disabled={restart.isPending}
                onClick={() => restart.mutate({ id: run.id, stepNumber: step.stepNumber })}
              >
                Restart from here
              </Button>
            </Stack>
          </AccordionDetails>
        </Accordion>
      ))}
    </Stack>
  );
}
