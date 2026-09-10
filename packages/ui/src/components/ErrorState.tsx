import { Alert, Paper, Typography } from "@mui/material";
import { ApiError } from "../api/client";

export function ErrorState({ error }: { error: unknown }) {
  const code = error instanceof ApiError ? error.code : undefined;
  const message = error instanceof Error ? error.message : "Unexpected error";
  return (
    <Alert severity="error" sx={{ my: 2 }}>
      {message}
      {code && (
        <Typography variant="caption" display="block">
          {code}
        </Typography>
      )}
    </Alert>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <Paper sx={{ p: 3 }}>
      <Typography color="text.secondary">{message}</Typography>
    </Paper>
  );
}

export function NotFoundState({ message }: { message: string }) {
  return (
    <Paper sx={{ p: 3 }}>
      <Typography variant="h6">Not found</Typography>
      <Typography color="text.secondary">{message}</Typography>
    </Paper>
  );
}
