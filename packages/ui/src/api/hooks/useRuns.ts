import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../client";

export interface WorkflowRunSummary {
  id: number;
  name: string;
  version: string;
  status: string;
  currentStep: number;
  updatedDate: string;
  parentRunId?: number | null;
  depth?: number;
}

export interface StepRunView {
  id: number;
  stepNumber: number;
  stepName: string;
  stepType: string;
  status: string;
  message?: string | null;
  inputs?: unknown;
  outputs?: unknown;
  state?: unknown;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  inputs?: unknown;
  outputs?: unknown;
  state?: unknown;
  stepRuns: StepRunView[];
}

export interface RunListResult {
  rows: WorkflowRunSummary[];
  total: number;
}

export interface RunListParams {
  status?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

const TERMINAL = new Set(["complete", "failed", "cancelled"]);

export function useRuns(params: RunListParams) {
  return useQuery({
    queryKey: ["runs", params],
    queryFn: async (): Promise<RunListResult> =>
      // The generated WorkflowRunList/WorkflowRun schemas declare `updatedDate`
      // (and `stepRuns`) as optional, while every run this UI renders always
      // has one — see task-7-report.md for the exact mismatch. The cast below
      // stays because of that, not because RunListResult is the wrong shape.
      unwrap(await api.GET("/api/v1/runs", { params: { query: params } })) as RunListResult,
  });
}

/** POST /api/v1/runs/search. Disabled until a filter is supplied. */
export function useSearchRuns(filter: Record<string, unknown> | null) {
  return useQuery({
    queryKey: ["runs", "search", filter],
    enabled: filter !== null,
    queryFn: async (): Promise<WorkflowRunSummary[]> =>
      // The generated request body type for this operation is
      // `{ filter?: Record<string, never> }`, but the server (and this
      // screen's own MSW fixture) expects the filter map posted directly as
      // the JSON body — see task-7-report.md. `as never` is the narrowest
      // cast that bridges that gap without reaching for `as unknown as`.
      unwrap(
        await api.POST("/api/v1/runs/search", { body: filter as never })
      ) as WorkflowRunSummary[],
  });
}

export function useRun(id: number) {
  return useQuery({
    queryKey: ["run", id],
    queryFn: async (): Promise<WorkflowRunDetail> =>
      unwrap(await api.GET("/api/v1/runs/{id}", { params: { path: { id } } })) as WorkflowRunDetail,
    // Poll only while there is something to watch; a finished run never
    // changes, so polling it is pure noise against the server.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && !TERMINAL.has(status) ? 3000 : false;
    },
  });
}

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number): Promise<void> => {
      unwrap(await api.PUT("/api/v1/runs/{id}/cancel", { params: { path: { id } } }));
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["run", id] });
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

export function useRestartRunFromStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, stepNumber }: { id: number; stepNumber: number }): Promise<void> => {
      unwrap(
        await api.PUT("/api/v1/runs/{id}/restart/step/{n}", {
          params: { path: { id, n: stepNumber } },
        })
      );
    },
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ["run", id] });
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}
