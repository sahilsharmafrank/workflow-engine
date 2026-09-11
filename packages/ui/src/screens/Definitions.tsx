import { Alert, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { ChangeEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFilterConfiguration } from "../api/hooks/useFilterConfiguration";
import { ImportItem, WorkflowDefinitionSummary, useDefinitions, useImportDefinitions } from "../api/hooks/useDefinitions";
import { Column, DataTable } from "../components/DataTable";
import { ErrorState } from "../components/ErrorState";
import { FilterBar } from "../components/FilterBar";
import { StatusPill } from "../components/StatusPill";

const columns: Column<WorkflowDefinitionSummary>[] = [
  { key: "name", header: "Name", render: (d) => d.name, sortValue: (d) => d.name },
  { key: "version", header: "Version", render: (d) => d.version, sortValue: (d) => d.version },
  { key: "status", header: "Status", render: (d) => <StatusPill status={d.status} />, sortValue: (d) => d.status },
  { key: "updatedDate", header: "Updated", render: (d) => new Date(d.updatedDate).toLocaleString(), sortValue: (d) => d.updatedDate },
];

export function Definitions() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [parseError, setParseError] = useState<string | null>(null);
  const config = useFilterConfiguration();
  const { data, isLoading, error } = useDefinitions(filters);
  const importDefs = useImportDefinitions();

  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    setParseError(null);
    importDefs.reset();
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    try {
      const items: ImportItem[] = [];
      for (const file of files) {
        const parsed = JSON.parse(await file.text());
        // The endpoint accepts an object or an array; flatten so one upload of
        // an array file behaves the same as several single-definition files.
        items.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      }
      importDefs.mutate(items);
    } catch (err) {
      setParseError(`Could not read the file as JSON: ${(err as Error).message}`);
    } finally {
      event.target.value = "";
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="h5">Definitions</Typography>
        <Button component="label" variant="outlined">
          Upload
          <input
            hidden
            multiple
            type="file"
            accept="application/json,.json"
            aria-label="Upload definitions"
            onChange={onUpload}
          />
        </Button>
      </Stack>

      {parseError && <Alert severity="error">{parseError}</Alert>}
      {importDefs.error && <ErrorState error={importDefs.error} />}
      {importDefs.isSuccess && (
        <Alert severity="success">
          Imported {importDefs.data.imported} definition{importDefs.data.imported === 1 ? "" : "s"}.
        </Alert>
      )}

      {config.data && <FilterBar fields={config.data.definitions} value={filters} onChange={setFilters} />}
      {error && <ErrorState error={error} />}
      {isLoading ? (
        <CircularProgress />
      ) : (
        <DataTable
          columns={columns}
          rows={data?.rows ?? []}
          getRowKey={(d) => d.id}
          onRowClick={(d) => navigate(`/definitions/${d.id}`)}
          emptyMessage="No definitions yet. Upload one to get started."
        />
      )}
    </Stack>
  );
}
