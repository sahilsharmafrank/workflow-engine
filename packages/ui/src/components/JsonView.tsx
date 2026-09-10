import { Box, Typography } from "@mui/material";

export function JsonView({ value, label }: { value: unknown; label?: string }) {
  const isEmpty = value == null || (typeof value === "object" && Object.keys(value as object).length === 0);
  return (
    <Box>
      {label && (
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
      )}
      <Box
        component="pre"
        sx={{
          m: 0, p: 1, bgcolor: "grey.100", borderRadius: 1,
          fontSize: 12, overflowX: "auto", maxHeight: 320,
        }}
      >
        {isEmpty ? "—" : JSON.stringify(value, null, 2)}
      </Box>
    </Box>
  );
}
