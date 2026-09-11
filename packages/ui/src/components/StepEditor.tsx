import { ArrowDownward, ArrowUpward, Delete, ExpandMore } from "@mui/icons-material";
import {
  Accordion, AccordionDetails, AccordionSummary, Autocomplete, Checkbox,
  FormControlLabel, IconButton, Stack, TextField, Typography,
} from "@mui/material";
import type { StepDefinition } from "@wfe/sdk";
import { PreFlightCheckActionOutcome } from "@wfe/sdk";
import type { StepType } from "../api/hooks/useStepTypes";
import { CaptureExpressionList } from "./CaptureExpressionList";
import { PreFlightCheckEditor } from "./PreFlightCheckEditor";

interface Props {
  index: number;
  step: StepDefinition;
  stepTypes: StepType[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (next: StepDefinition) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

/**
 * One step's fields inside DefinitionEditor's step list (design doc §6):
 * name/version/type, the three capture-expression lists, and an optional
 * preflight check.
 */
export function StepEditor({
  index, step, stepTypes, canMoveUp, canMoveDown, onChange, onRemove, onMoveUp, onMoveDown,
}: Props) {
  function set<K extends keyof StepDefinition>(field: K, val: StepDefinition[K]) {
    onChange({ ...step, [field]: val });
  }

  function togglePreFlightCheck(enabled: boolean) {
    set(
      "preFlightCheck",
      enabled ? { conditionsToCheck: [], actionOnFailure: PreFlightCheckActionOutcome.FAIL } : undefined
    );
  }

  return (
    <Accordion defaultExpanded>
      <AccordionSummary expandIcon={<ExpandMore />}>
        <Typography>{step.stepName || `Step ${index + 1}`}</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1}>
            <IconButton aria-label={`Move step ${index + 1} up`} disabled={!canMoveUp} onClick={onMoveUp} size="small">
              <ArrowUpward fontSize="small" />
            </IconButton>
            <IconButton aria-label={`Move step ${index + 1} down`} disabled={!canMoveDown} onClick={onMoveDown} size="small">
              <ArrowDownward fontSize="small" />
            </IconButton>
            <IconButton aria-label={`Remove step ${index + 1}`} onClick={onRemove} size="small">
              <Delete fontSize="small" />
            </IconButton>
          </Stack>

          <Stack direction="row" spacing={2} flexWrap="wrap">
            <TextField
              size="small" required label="Step name"
              value={step.stepName}
              onChange={(e) => set("stepName", e.target.value)}
            />
            <TextField
              size="small" required label="Step version"
              value={step.stepVersion}
              onChange={(e) => set("stepVersion", e.target.value)}
            />
            <Autocomplete
              freeSolo
              size="small"
              options={stepTypes.map((t) => t.type)}
              inputValue={step.stepType ?? ""}
              onInputChange={(_, next) => set("stepType", next)}
              renderInput={(params) => <TextField {...params} required label="Step type" />}
              sx={{ minWidth: 220 }}
            />
          </Stack>

          <CaptureExpressionList
            label="Inputs"
            value={step.stepInputs}
            onChange={(stepInputs) => set("stepInputs", stepInputs)}
          />
          <CaptureExpressionList
            label="Outputs"
            value={step.stepOutputs ?? []}
            onChange={(stepOutputs) => set("stepOutputs", stepOutputs)}
          />
          <CaptureExpressionList
            label="State capture"
            value={step.stepStateCapture ?? []}
            onChange={(stepStateCapture) => set("stepStateCapture", stepStateCapture)}
          />

          <FormControlLabel
            control={
              <Checkbox
                checked={step.preFlightCheck !== undefined}
                onChange={(e) => togglePreFlightCheck(e.target.checked)}
              />
            }
            label="Preflight check"
          />
          {step.preFlightCheck && (
            <PreFlightCheckEditor
              value={step.preFlightCheck}
              onChange={(preFlightCheck) => set("preFlightCheck", preFlightCheck)}
            />
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
