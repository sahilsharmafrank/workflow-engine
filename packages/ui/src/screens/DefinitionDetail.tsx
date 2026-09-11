import { Button, CircularProgress, Paper, Stack, Typography } from "@mui/material";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useDefinition, useDefinitions, usePublishDefinition } from "../api/hooks/useDefinitions";
import { ErrorState, NotFoundState } from "../components/ErrorState";
import { Column, DataTable } from "../components/DataTable";
import { JsonView } from "../components/JsonView";
import { StatusPill } from "../components/StatusPill";
import type { WorkflowDefinitionSummary } from "../api/hooks/useDefinitions";

const historyColumns: Column<WorkflowDefinitionSummary>[] = [
  { key: "version", header: "Version", render: (d) => d.version, sortValue: (d) => d.version },
  { key: "status", header: "Status", render: (d) => <StatusPill status={d.status} /> },
  { key: "updatedDate", header: "Updated", render: (d) => new Date(d.updatedDate).toLocaleString(), sortValue: (d) => d.updatedDate },
];

export function DefinitionDetail() {
  const { id } = useParams();
  const { data, isLoading, error } = useDefinition(Number(id));
  // Identity is name + version, so "version history" is just this definition's
  // siblings by name — no dedicated endpoint needed. Gated on `data` so this
  // fires once, with the real name filter, instead of first issuing a wasted
  // unfiltered GET /definitions on every render before the detail resolves.
  const history = useDefinitions(data ? { name: data.name } : {}, { enabled: Boolean(data) });
  const publish = usePublishDefinition();

  if (isLoading) return <CircularProgress />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundState message={error.message} />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  // The single publish endpoint transitions DRAFT->PUBLISHED or
  // PUBLISHED->ARCHIVED depending on current status (DefinitionRepository.publish());
  // the button's label follows the same table so it always names the transition
  // this click will actually perform, and disappears once ARCHIVED has nowhere
  // left to go (design doc §3).
  const publishLabel = data.status === "draft" ? "Publish" : data.status === "published" ? "Archive" : null;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="h5">
          {data.name} {data.version}
        </Typography>
        <StatusPill status={data.status} />
        {data.status === "draft" && (
          <Button component={Link} to={`/definitions/${data.id}/edit`} variant="outlined" size="small">
            Edit
          </Button>
        )}
        {publishLabel && (
          <Button
            variant="outlined" size="small"
            disabled={publish.isPending}
            onClick={() => publish.mutate(data.id)}
          >
            {publishLabel}
          </Button>
        )}
      </Stack>

      {publish.error && <ErrorState error={publish.error} />}

      <Typography variant="h6">Definition</Typography>
      <Paper sx={{ p: 2 }}>
        <JsonView value={data.definition} />
      </Paper>

      <Typography variant="h6">Versions</Typography>
      <DataTable
        columns={historyColumns}
        rows={history.data?.rows ?? []}
        getRowKey={(d) => d.id}
        emptyMessage="No other versions."
      />
    </Stack>
  );
}
