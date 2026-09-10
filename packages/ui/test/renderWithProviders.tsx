import { ThemeProvider, createTheme } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RenderResult, render } from "@testing-library/react";
import { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";

export function renderWithProviders(ui: ReactElement, opts: { route?: string } = {}): RenderResult {
  // Retries off in tests: a retrying query turns an assertion failure into a
  // timeout, which hides what actually went wrong.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <ThemeProvider theme={createTheme()}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[opts.route ?? "/"]}>{ui}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
