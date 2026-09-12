import { Add } from "@mui/icons-material";
import { Alert, Button, CircularProgress, FormHelperText, Paper, Stack, TextField, Typography } from "@mui/material";
import type { StepDefinition, WorkflowDefinitionBody } from "@wfe/sdk";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCreateDefinition, useDefinition, useUpdateDefinition } from "../api/hooks/useDefinitions";
import { useStepTypes } from "../api/hooks/useStepTypes";
import { ErrorState } from "../components/ErrorState";
import { JsonView } from "../components/JsonView";
import { StepEditor } from "../components/StepEditor";

interface FieldErrors {
  name?: string;
  version?: string;
  steps?: string;
  stepName?: Record<number, string>;
  stepVersion?: Record<number, string>;
}

function emptyStep(): StepDefinition {
  return { stepName: "", stepVersion: "", stepType: "", stepInputs: [] };
}

/**
 * Required-field-only client validation (design doc §7): every rule here
 * mirrors a field the server's own yup schema also requires, so this can
 * never disagree with a rejection the server would issue anyway. Everything
 * else — duplicate names, unknown types, DEFINITION_INVALID's own field
 * list — is left to the server response, surfaced verbatim through ErrorState.
 */
function validate(name: string, isCreate: boolean, version: string, steps: StepDefinition[]): FieldErrors {
  const errors: FieldErrors = {};
  if (isCreate && !name.trim()) errors.name = "Name is required.";
  if (!version.trim()) errors.version = "Version is required.";
  if (steps.length === 0) errors.steps = "At least one step is required.";

  for (const [i, step] of steps.entries()) {
    if (!step.stepName.trim()) errors.stepName = { ...errors.stepName, [i]: "Step name is required." };
    if (!step.stepVersion.trim()) errors.stepVersion = { ...errors.stepVersion, [i]: "Step version is required." };
  }
  return errors;
}

function hasErrors(errors: FieldErrors): boolean {
  return Boolean(errors.name || errors.version || errors.steps || errors.stepName || errors.stepVersion);
}

export function DefinitionEditor() {
  const { id } = useParams();
  const isCreate = id === undefined;
  const navigate = useNavigate();
  const existing = useDefinition(Number(id), { enabled: !isCreate });
  const stepTypes = useStepTypes();
  const createDef = useCreateDefinition();
  const updateDef = useUpdateDefinition();

  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [steps, setSteps] = useState<StepDefinition[]>([]);
  const [touched, setTouched] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Pre-fill from the loaded definition exactly once, when it arrives — not
  // on every render, or a save's own refetch would blow away in-progress edits.
  if (!isCreate && existing.data && !initialized) {
    setName(existing.data.name);
    setVersion(existing.data.version);
    setSteps((existing.data.definition as WorkflowDefinitionBody).steps);
    setInitialized(true);
  }

  const errors = useMemo(() => validate(name, isCreate, version, steps), [name, isCreate, version, steps]);

  if (!isCreate && existing.isLoading) return <CircularProgress />;
  if (!isCreate && existing.error) return <ErrorState error={existing.error} />;
  if (!isCreate && existing.data && existing.data.status !== "draft") {
    return <Alert severity="warning">Only a draft definition can be edited.</Alert>;
  }

  const mutation = isCreate ? createDef : updateDef;

  function onSave() {
    setTouched(true);
    if (hasErrors(errors)) return;
    const body: WorkflowDefinitionBody = { steps };
    if (isCreate) {
      createDef.mutate(
        { name, version, definition: body },
        { onSuccess: (created) => navigate(`/definitions/${created.id}`) }
      );
    } else {
      updateDef.mutate(
        { id: Number(id), version, definition: body },
        { onSuccess: () => navigate(`/definitions/${id}`) }
      );
    }
  }

  function addStep() {
    setSteps([...steps, emptyStep()]);
  }

  function updateStep(index: number, next: StepDefinition) {
    setSteps(steps.map((s, i) => (i === index ? next : s)));
  }

  function removeStep(index: number) {
    setSteps(steps.filter((_, i) => i !== index));
  }

  function moveStep(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    setSteps(next);
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h5">{isCreate ? "New definition" : `Edit ${name} ${version}`}</Typography>

      <Stack direction="row" spacing={2}>
        <TextField
          size="small" label="Name" required
          value={name}
          disabled={!isCreate}
          onChange={(e) => setName(e.target.value)}
          error={touched && Boolean(errors.name)}
          helperText={touched ? errors.name : undefined}
        />
        <TextField
          size="small" label="Version" required
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          error={touched && Boolean(errors.version)}
          helperText={touched ? errors.version : undefined}
        />
      </Stack>

      <Typography variant="h6">Steps</Typography>
      {touched && errors.steps && <FormHelperText error>{errors.steps}</FormHelperText>}
      <Stack spacing={2}>
        {steps.map((step, i) => (
          <Stack key={i} spacing={0.5}>
            <StepEditor
              index={i}
              step={step}
              stepTypes={stepTypes.data ?? []}
              canMoveUp={i > 0}
              canMoveDown={i < steps.length - 1}
              onChange={(next) => updateStep(i, next)}
              onRemove={() => removeStep(i)}
              onMoveUp={() => moveStep(i, -1)}
              onMoveDown={() => moveStep(i, 1)}
            />
            {touched && errors.stepName?.[i] && <FormHelperText error>{errors.stepName[i]}</FormHelperText>}
            {touched && errors.stepVersion?.[i] && <FormHelperText error>{errors.stepVersion[i]}</FormHelperText>}
          </Stack>
        ))}
      </Stack>
      <Button startIcon={<Add />} onClick={addStep} sx={{ alignSelf: "flex-start" }}>
        Add step
      </Button>

      <Typography variant="h6">Preview</Typography>
      <Paper sx={{ p: 2 }}>
        <JsonView value={{ steps }} />
      </Paper>

      {mutation.error && <ErrorState error={mutation.error} />}
      <Button variant="contained" onClick={onSave} disabled={mutation.isPending} sx={{ alignSelf: "flex-start" }}>
        Save
      </Button>
    </Stack>
  );
}
