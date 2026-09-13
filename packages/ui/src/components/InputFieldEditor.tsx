import { Add, Delete } from "@mui/icons-material";
import {
  Button, Checkbox, FormControlLabel, IconButton, MenuItem, Stack, TextField, Typography,
} from "@mui/material";
import type { WorkflowInputField, WorkflowInputFieldType } from "@wfe/sdk";

interface Props {
  value: WorkflowInputField[];
  onChange: (next: WorkflowInputField[]) => void;
}

const FIELD_TYPES: WorkflowInputFieldType[] = ["string", "number", "boolean", "json"];

/**
 * Add/remove editor for a workflow definition's declared inputSchema
 * (design doc §6) — the run-level counterpart to CaptureExpressionList's
 * per-step capture lists, with its own "Workflow input …" label prefix so
 * the two never collide inside the same rendered form.
 */
export function InputFieldEditor({ value, onChange }: Props) {
  function update<K extends keyof WorkflowInputField>(index: number, field: K, next: WorkflowInputField[K]) {
    onChange(value.map((row, i) => (i === index ? { ...row, [field]: next } : row)));
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...value, { name: "", type: "string", required: false, description: "" }]);
  }

  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">Workflow inputs</Typography>
      {value.map((row, i) => (
        <Stack key={i} direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <TextField
            size="small"
            label={`Workflow input name ${i + 1}`}
            value={row.name}
            onChange={(e) => update(i, "name", e.target.value)}
          />
          <TextField
            size="small"
            select
            label={`Workflow input type ${i + 1}`}
            value={row.type}
            onChange={(e) => update(i, "type", e.target.value as WorkflowInputFieldType)}
            sx={{ minWidth: 120 }}
          >
            {FIELD_TYPES.map((t) => (
              <MenuItem key={t} value={t}>{t}</MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={
              <Checkbox
                aria-label={`Workflow input required ${i + 1}`}
                checked={row.required}
                onChange={(e) => update(i, "required", e.target.checked)}
              />
            }
            label="Required"
          />
          <TextField
            size="small"
            label={`Workflow input description ${i + 1}`}
            value={row.description ?? ""}
            onChange={(e) => update(i, "description", e.target.value)}
            sx={{ flexGrow: 1 }}
          />
          <IconButton aria-label={`Remove workflow input row ${i + 1}`} onClick={() => remove(i)} size="small">
            <Delete fontSize="small" />
          </IconButton>
        </Stack>
      ))}
      <Button size="small" startIcon={<Add />} onClick={add} sx={{ alignSelf: "flex-start" }}>
        Add workflow input
      </Button>
    </Stack>
  );
}
