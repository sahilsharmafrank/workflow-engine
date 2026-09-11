import { Add, Delete } from "@mui/icons-material";
import { Button, IconButton, Stack, TextField, Typography } from "@mui/material";
import type { ParameterCaptureExpression } from "@wfe/sdk";

interface Props {
  label: string;
  value: ParameterCaptureExpression[];
  onChange: (next: ParameterCaptureExpression[]) => void;
}

/**
 * Add/remove editor for a list of {targetFieldName, modelEvaluationExpression}
 * pairs — the shape shared by stepInputs, stepOutputs, stepStateCapture and
 * preFlightCheck.conditionsToCheck (packages/sdk/src/types.ts).
 */
export function CaptureExpressionList({ label, value, onChange }: Props) {
  function update(index: number, field: keyof ParameterCaptureExpression, next: string) {
    onChange(value.map((row, i) => (i === index ? { ...row, [field]: next } : row)));
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...value, { targetFieldName: "", modelEvaluationExpression: "" }]);
  }

  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{label}</Typography>
      {value.map((row, i) => (
        <Stack key={i} direction="row" spacing={1} alignItems="center">
          <TextField
            size="small"
            label={`${label} field name ${i + 1}`}
            value={row.targetFieldName}
            onChange={(e) => update(i, "targetFieldName", e.target.value)}
          />
          <TextField
            size="small"
            label={`${label} expression ${i + 1}`}
            value={row.modelEvaluationExpression}
            onChange={(e) => update(i, "modelEvaluationExpression", e.target.value)}
            sx={{ flexGrow: 1 }}
          />
          <IconButton aria-label={`Remove ${label} row ${i + 1}`} onClick={() => remove(i)} size="small">
            <Delete fontSize="small" />
          </IconButton>
        </Stack>
      ))}
      <Button size="small" startIcon={<Add />} onClick={add} sx={{ alignSelf: "flex-start" }}>
        Add {label.toLowerCase()} row
      </Button>
    </Stack>
  );
}
