import { CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { useMemo, useState } from "react";
import { StepType, useStepTypes } from "../api/hooks/useStepTypes";
import { Column, DataTable } from "../components/DataTable";
import { EmptyState, ErrorState } from "../components/ErrorState";

const columns: Column<StepType>[] = [
  { key: "type", header: "Type", render: (r) => r.type, sortValue: (r) => r.type },
  { key: "version", header: "Version", render: (r) => r.version, sortValue: (r) => r.version },
  { key: "description", header: "Description", render: (r) => r.description ?? "" },
];

export function StepCatalog() {
  const { data, isLoading, error } = useStepTypes();
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (t) => t.type.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q)
    );
  }, [data, search]);

  if (isLoading) return <CircularProgress />;
  if (error) return <ErrorState error={error} />;

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Step catalog</Typography>
      <Typography variant="body2" color="text.secondary">
        Step types registered in this deployment, including any contributed by plugins.
      </Typography>
      <TextField
        size="small"
        label="Search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        sx={{ maxWidth: 320 }}
      />
      {rows.length === 0 && search ? (
        <EmptyState message={`No step type matches "${search}".`} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.type}
          emptyMessage="No step types are registered."
        />
      )}
    </Stack>
  );
}
