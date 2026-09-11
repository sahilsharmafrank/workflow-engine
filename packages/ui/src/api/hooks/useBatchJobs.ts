import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../client";

export interface BatchJobSummary {
  id: number;
  name: string;
  definitionName: string;
  definitionVersion: string;
  status: string;
  totalCount: number;
  message?: string;
  createdDate: string;
  updatedDate: string;
}

export interface BatchJobProgress {
  completedCount: number;
  failedCount: number;
  runningCount: number;
}

export interface BatchJobDetailView extends BatchJobSummary {
  runIds: number[];
  inputs: unknown[];
  progress: BatchJobProgress;
}

const TERMINAL = new Set(["complete", "failed", "cancelled"]);

export function useBatchJobs() {
  return useQuery({
    queryKey: ["batch-jobs"],
    // R3: unlike the run and definition list endpoints, GET /api/v1/batch-jobs
    // returns a plain array — the generated schema declares
    // `{"type":"array","items":{"$ref":"#/components/schemas/BatchJob"}}`,
    // matching BatchJobRepository.list()'s `qb.getMany()`, which has no
    // `{ rows, total }` wrapper. Cast narrows the richer generated BatchJob[]
    // (which also carries tenantId/inputs/runIds) to the summary shape this
    // screen actually reads.
    queryFn: async (): Promise<BatchJobSummary[]> =>
      unwrap(await api.GET("/api/v1/batch-jobs", {})) as BatchJobSummary[],
  });
}

export function useBatchJob(id: number) {
  return useQuery({
    queryKey: ["batch-job", id],
    queryFn: async (): Promise<BatchJobDetailView> =>
      unwrap(await api.GET("/api/v1/batch-jobs/{id}", { params: { path: { id } } })) as BatchJobDetailView,
    // Poll only while there is something to watch, matching useRun's pattern.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && !TERMINAL.has(status) ? 3000 : false;
    },
  });
}

export function useCancelBatchJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number): Promise<void> => {
      // The schema declares only 200/404 for this endpoint, but the server
      // really answers 409 BATCH_JOB_NOT_CANCELLABLE for a job already in a
      // terminal state (see packages/server/src/controllers/batch-jobs.ts).
      // unwrap() throws an ApiError carrying whatever code the body actually
      // has regardless of what the schema declares, so no cast is needed here
      // to surface it — only BatchJobDetail's error rendering has to handle
      // a code the types never promised.
      unwrap(await api.PUT("/api/v1/batch-jobs/{id}/cancel", { params: { path: { id } } }));
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["batch-job", id] });
      qc.invalidateQueries({ queryKey: ["batch-jobs"] });
      // Cancelling a batch cancels its live runs, so the run views are stale too.
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}
