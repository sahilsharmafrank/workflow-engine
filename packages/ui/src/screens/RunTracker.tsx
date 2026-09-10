import { Button, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFilterConfiguration } from "../api/hooks/useFilterConfiguration";
import { WorkflowRunSummary, useRuns, useSearchRuns } from "../api/hooks/useRuns";
import { Column, DataTable } from "../components/DataTable";
import { ErrorState } from "../components/ErrorState";
import { FilterBar } from "../components/FilterBar";
import { StatusPill } from "../components/StatusPill";

const columns: Column<WorkflowRunSummary>[] = [
  { key: "id", header: "Run", render: (r) => r.id, sortValue: (r) => r.id },
  { key: "name", header: "Name", render: (r) => r.name, sortValue: (r) => r.name },
  { key: "version", header: "Version", render: (r) => r.version },
  { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} />, sortValue: (r) => r.status },
  { key: "currentStep", header: "Step", render: (r) => r.currentStep, sortValue: (r) => r.currentStep },
  { key: "updatedDate", header: "Updated", render: (r) => new Date(r.updatedDate).toLocaleString(), sortValue: (r) => r.updatedDate },
];

export function RunTracker() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [searchKey, setSearchKey] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const [activeSearch, setActiveSearch] = useState<Record<string, unknown> | null>(null);

  const config = useFilterConfiguration();
  const list = useRuns(filters);
  const search = useSearchRuns(activeSearch);

  const searching = activeSearch !== null;
  const rows = searching ? search.data ?? [] : list.data?.rows ?? [];
  const error = searching ? search.error : list.error;
  const loading = searching ? search.isLoading : list.isLoading;

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Runs</Typography>

      {config.data && <FilterBar fields={config.data.runs} value={filters} onChange={setFilters} />}

      <Stack direction="row" spacing={1} alignItems="center">
        <TextField
          size="small"
          label="Search key"
          placeholder="inputs.jobId"
          value={searchKey}
          onChange={(e) => setSearchKey(e.target.value)}
        />
        <TextField
          size="small"
          label="Search value"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
        />
        <Button
          variant="outlined"
          onClick={() => setActiveSearch(searchKey ? { [searchKey]: searchValue } : null)}
        >
          Search
        </Button>
        {searching && (
          <Button
            onClick={() => {
              setActiveSearch(null);
              setSearchKey("");
              setSearchValue("");
            }}
          >
            Clear
          </Button>
        )}
      </Stack>

      {/* The server allowlists the column and constrains path segments, so a
          malformed key comes back as RUN_SEARCH_INVALID_FILTER_KEY. Showing
          that message is more useful than pre-validating here and guessing. */}
      {error && <ErrorState error={error} />}
      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          emptyMessage={searching ? "No run matches that search." : "No runs yet."}
        />
      )}
    </Stack>
  );
}
