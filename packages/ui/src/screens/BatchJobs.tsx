import { CircularProgress, Stack, Typography } from "@mui/material";
import { useNavigate } from "react-router-dom";
import { BatchJobSummary, useBatchJobs } from "../api/hooks/useBatchJobs";
import { Column, DataTable } from "../components/DataTable";
import { ErrorState } from "../components/ErrorState";
import { StatusPill } from "../components/StatusPill";

const columns: Column<BatchJobSummary>[] = [
  { key: "id", header: "Job", render: (b) => b.id, sortValue: (b) => b.id },
  { key: "name", header: "Name", render: (b) => b.name, sortValue: (b) => b.name },
  { key: "definition", header: "Definition", render: (b) => `${b.definitionName} ${b.definitionVersion}` },
  { key: "status", header: "Status", render: (b) => <StatusPill status={b.status} />, sortValue: (b) => b.status },
  { key: "totalCount", header: "Runs", render: (b) => b.totalCount, sortValue: (b) => b.totalCount },
  { key: "createdDate", header: "Created", render: (b) => new Date(b.createdDate).toLocaleString(), sortValue: (b) => b.createdDate },
];

export function BatchJobs() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useBatchJobs();

  if (isLoading) return <CircularProgress />;
  if (error) return <ErrorState error={error} />;

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Batch jobs</Typography>
      <DataTable
        columns={columns}
        // R3: GET /api/v1/batch-jobs returns a plain array, not { rows, total }
        // like the run and definition list endpoints, so this reads the query
        // result directly rather than `data?.rows ?? []`.
        rows={data ?? []}
        getRowKey={(b) => b.id}
        onRowClick={(b) => navigate(`/batch-jobs/${b.id}`)}
        emptyMessage="No batch jobs yet."
      />
    </Stack>
  );
}
