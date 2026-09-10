import { MenuItem, Stack, TextField } from "@mui/material";
import type { FilterField } from "../api/hooks/useFilterConfiguration";

interface Props {
  fields: FilterField[];
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

/**
 * Renders whatever GET /filter-configuration describes. Nothing here hardcodes
 * a status list or a step type — that endpoint exists so the engine's registry
 * stays the source of truth.
 */
export function FilterBar({ fields, value, onChange }: Props) {
  function set(field: string, next: string) {
    const merged = { ...value, [field]: next };
    if (next === "") delete merged[field];
    onChange(merged);
  }

  return (
    <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: "wrap" }}>
      {fields.map((f) => {
        if (f.type === "enum") {
          return (
            <TextField
              key={f.field}
              select
              size="small"
              label={f.field}
              value={value[f.field] ?? ""}
              onChange={(e) => set(f.field, e.target.value)}
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="">Any</MenuItem>
              {(f.values ?? []).map((v) => (
                <MenuItem key={v} value={v}>
                  {v}
                </MenuItem>
              ))}
            </TextField>
          );
        }
        if (f.type === "dateRange") {
          // Date-range filtering is not wired to a server parameter yet — GET
          // /runs accepts status, name, limit and offset only. Rendering an
          // inert control would imply a capability that does not exist.
          return null;
        }
        return (
          <TextField
            key={f.field}
            size="small"
            label={f.field}
            value={value[f.field] ?? ""}
            onChange={(e) => set(f.field, e.target.value)}
          />
        );
      })}
    </Stack>
  );
}
