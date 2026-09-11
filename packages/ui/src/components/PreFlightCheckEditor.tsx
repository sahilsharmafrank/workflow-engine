import { MenuItem, Stack, TextField } from "@mui/material";
import { PreFlightCheckActionOutcome } from "@wfe/sdk";
import type { PreFlightCheckParameters } from "@wfe/sdk";
import { CaptureExpressionList } from "./CaptureExpressionList";

interface Props {
  value: PreFlightCheckParameters | undefined;
  onChange: (next: PreFlightCheckParameters) => void;
}

const EMPTY_CHECK: PreFlightCheckParameters = {
  conditionsToCheck: [],
  actionOnFailure: PreFlightCheckActionOutcome.FAIL,
};

/**
 * A step's preflight check is optional at the definition level — absent
 * means "no check" (packages/sdk/src/types.ts). Whether the check exists at
 * all is the caller's decision (StepEditor's checkbox); this component only
 * edits the fields of one that already exists, defaulting to an empty one
 * so it always has something to render.
 */
export function PreFlightCheckEditor({ value, onChange }: Props) {
  const check = value ?? EMPTY_CHECK;

  return (
    <Stack spacing={1}>
      <CaptureExpressionList
        label="Conditions to check"
        value={check.conditionsToCheck}
        onChange={(conditionsToCheck) => onChange({ ...check, conditionsToCheck })}
      />
      <TextField
        select
        size="small"
        label="Action on failure"
        value={check.actionOnFailure}
        onChange={(e) => onChange({ ...check, actionOnFailure: e.target.value as PreFlightCheckActionOutcome })}
        sx={{ maxWidth: 240 }}
      >
        {Object.values(PreFlightCheckActionOutcome).map((v) => (
          <MenuItem key={v} value={v}>{v}</MenuItem>
        ))}
      </TextField>
      <TextField
        size="small"
        label="Failure message"
        value={check.failureMessage ?? ""}
        onChange={(e) => onChange({ ...check, failureMessage: e.target.value })}
      />
    </Stack>
  );
}
