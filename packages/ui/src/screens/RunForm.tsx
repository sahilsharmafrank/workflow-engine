import { Alert, Button, Checkbox, CircularProgress, FormControlLabel, Stack, TextField, Typography } from "@mui/material";
import type { WorkflowDefinitionBody, WorkflowInputField, WorkflowParameters } from "@wfe/sdk";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCreateRun } from "../api/hooks/useRuns";
import { ApiError } from "../api/client";
import { useDefinition } from "../api/hooks/useDefinitions";
import { ErrorState, NotFoundState } from "../components/ErrorState";

type FieldValue = string | boolean;

function initialValues(fields: WorkflowInputField[]): Record<string, FieldValue> {
  return Object.fromEntries(fields.map((f) => [f.name, f.type === "boolean" ? false : ""]));
}

/**
 * Presence-only client check mirroring the server's validateRunInputs
 * (design doc §5, §7): a required field is missing only when its value is
 * still the empty string — a boolean field is never "empty" since it always
 * carries true/false.
 */
function validate(fields: WorkflowInputField[], values: Record<string, FieldValue>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.required && field.type !== "boolean" && values[field.name] === "") {
      errors[field.name] = `${field.name} is required.`;
    }
  }
  return errors;
}

function toInputs(fields: WorkflowInputField[], values: Record<string, FieldValue>): WorkflowParameters {
  const inputs: WorkflowParameters = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (raw === "" || raw === undefined) continue;
    if (field.type === "number") inputs[field.name] = Number(raw);
    else if (field.type === "json") inputs[field.name] = JSON.parse(raw as string);
    else inputs[field.name] = raw;
  }
  return inputs;
}

export function RunForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useDefinition(Number(id));
  const createRun = useCreateRun();

  const fields = useMemo(
    () => ((data?.definition as WorkflowDefinitionBody | undefined)?.inputSchema ?? []),
    [data]
  );
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [touched, setTouched] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  if (data && !initialized) {
    setValues(initialValues(fields));
    setInitialized(true);
  }

  const errors = useMemo(() => validate(fields, values), [fields, values]);

  if (isLoading) return <CircularProgress />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundState message={error.message} />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  function set(name: string, next: FieldValue) {
    setValues((prev) => ({ ...prev, [name]: next }));
  }

  function onSubmit() {
    // Narrows `data` for TypeScript inside this closure: the `if (!data)
    // return null;` guard above already made this unreachable in practice
    // (onSubmit is only ever wired to a button rendered after that guard),
    // but control-flow narrowing doesn't cross a nested function boundary.
    if (!data) return;
    setTouched(true);
    setParseError(null);
    if (Object.keys(errors).length > 0) return;

    let inputs: WorkflowParameters;
    try {
      inputs = toInputs(fields, values);
    } catch {
      setParseError("One or more JSON fields could not be parsed.");
      return;
    }

    createRun.mutate(
      { name: data.name, version: data.version, inputs },
      { onSuccess: (result) => navigate(`/runs/${result.runId}`) }
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Run {data.name} {data.version}</Typography>

      {fields.map((field) => (
        <Stack key={field.name} spacing={0.5}>
          {field.type === "boolean" ? (
            <FormControlLabel
              control={
                <Checkbox
                  checked={Boolean(values[field.name])}
                  onChange={(e) => set(field.name, e.target.checked)}
                />
              }
              label={field.name}
            />
          ) : (
            <TextField
              size="small"
              label={field.name}
              required={field.required}
              type={field.type === "number" ? "number" : "text"}
              multiline={field.type === "json"}
              value={values[field.name] ?? ""}
              onChange={(e) => set(field.name, e.target.value)}
              error={touched && Boolean(errors[field.name])}
              helperText={(touched && errors[field.name]) || field.description}
            />
          )}
        </Stack>
      ))}

      {parseError && <Alert severity="error">{parseError}</Alert>}
      {createRun.error && <ErrorState error={createRun.error} />}

      <Button variant="contained" onClick={onSubmit} disabled={createRun.isPending} sx={{ alignSelf: "flex-start" }}>
        Run
      </Button>
    </Stack>
  );
}
