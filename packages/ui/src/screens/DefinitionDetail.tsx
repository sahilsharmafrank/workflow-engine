import { CircularProgress, Paper, Stack, Typography } from "@mui/material";
import { useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useDefinition, useDefinitions } from "../api/hooks/useDefinitions";
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

  if (isLoading) return <CircularProgress />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundState message={error.message} />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="h5">
          {data.name} {data.version}
        </Typography>
        <StatusPill status={data.status} />
      </Stack>

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
