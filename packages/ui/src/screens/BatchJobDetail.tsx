import { Button, Chip, CircularProgress, Paper, Stack, Typography } from "@mui/material";
import { Link as RouterLink, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useBatchJob, useCancelBatchJob } from "../api/hooks/useBatchJobs";
import { ErrorState, NotFoundState } from "../components/ErrorState";
import { JsonView } from "../components/JsonView";
import { StatusPill } from "../components/StatusPill";

export function BatchJobDetail() {
  const { id } = useParams();
  const jobId = Number(id);
  const { data: job, isLoading, error } = useBatchJob(jobId);
  const cancel = useCancelBatchJob();

  if (isLoading) return <CircularProgress />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundState message={error.message} />;
  if (error) return <ErrorState error={error} />;
  if (!job) return null;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="h5">{job.name}</Typography>
        <StatusPill status={job.status} />
        <Button variant="outlined" disabled={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
          Cancel batch
        </Button>
      </Stack>

      <Typography variant="body2" color="text.secondary">
        {job.definitionName} {job.definitionVersion}
      </Typography>

      {job.message && <Typography color="error">{job.message}</Typography>}
      {/* Undeclared in the schema (only 200/404 are documented for this
          endpoint) but real: the server answers 409 BATCH_JOB_NOT_CANCELLABLE
          for a job already in a terminal state. unwrap() throws an ApiError
          carrying that code regardless of what the schema declares, and
          ErrorState renders it, so this line is what actually surfaces it. */}
      {cancel.error && <ErrorState error={cancel.error} />}

      {/* The three counts and the total are shown as separate facts. They do
          not necessarily sum: computeProgress does not bucket cancelled runs,
          so any derived "remaining" figure would misreport a cancelled batch. */}
      <Stack direction="row" spacing={1}>
        <Chip color="success" label={`${job.progress.completedCount} complete`} />
        <Chip color="error" label={`${job.progress.failedCount} failed`} />
        <Chip color="info" label={`${job.progress.runningCount} running`} />
        <Chip variant="outlined" label={`${job.totalCount} total`} />
      </Stack>

      <Typography variant="h6">Runs</Typography>
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
          {job.runIds.length === 0 ? (
            <Typography color="text.secondary">This batch started no runs.</Typography>
          ) : (
            job.runIds.map((runId) => (
              <RouterLink key={runId} to={`/runs/${runId}`}>
                Run {runId}
              </RouterLink>
            ))
          )}
        </Stack>
      </Paper>

      <Typography variant="h6">Inputs</Typography>
      <Paper sx={{ p: 2 }}>
        <JsonView value={job.inputs} />
      </Paper>
    </Stack>
  );
}
