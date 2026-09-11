import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../client";

export interface WorkflowDefinitionSummary {
  id: number;
  name: string;
  version: string;
  status: string;
  updatedDate: string;
}

export interface WorkflowDefinitionDetail extends WorkflowDefinitionSummary {
  definition: unknown;
}

export interface DefinitionListResult {
  rows: WorkflowDefinitionSummary[];
  total: number;
}

export interface ImportItem {
  name: string;
  version: string;
  status?: string;
  definition: unknown;
}

export function useDefinitions(
  params: { status?: string; name?: string; limit?: number; offset?: number },
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: ["definitions", params],
    enabled: options?.enabled,
    queryFn: async (): Promise<DefinitionListResult> => {
      const result = await api.GET("/api/v1/definitions", {
        // The generated query type narrows `status` to the literal union
        // "draft" | "published" | "archived" (declared in the OpenAPI
        // document for this endpoint only — GET /runs' `status` stays a bare
        // `string`). FilterBar hands back whatever /filter-configuration's
        // enum values are, as plain strings, so this hook's params can't
        // adopt that literal union without coupling to it here. This cast
        // bridges that gap, not a real shape mismatch.
        params: { query: params as never },
      });
      // The generated WorkflowDefinitionList/WorkflowDefinition schemas
      // declare `updatedDate` as optional, while every definition this UI
      // renders always has one (same gap as WorkflowRunList/WorkflowRun in
      // useRuns.ts — see task-7-report.md and task-9-report.md). This cast
      // stays because of that, not because DefinitionListResult is the wrong
      // shape: removing it fails `tsc` on `updatedDate: string | undefined`
      // vs. the required `string` here.
      return unwrap(result) as DefinitionListResult;
    },
  });
}

export function useDefinition(id: number, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["definition", id],
    enabled: options?.enabled,
    queryFn: async (): Promise<WorkflowDefinitionDetail> => {
      const result = await api.GET("/api/v1/definitions/{id}", { params: { path: { id } } });
      // Same `updatedDate` optional-vs-required gap as useDefinitions above:
      // WorkflowDefinition declares it optional, WorkflowDefinitionDetail
      // requires it. The cast stays for that reason, not a real mismatch.
      return unwrap(result) as WorkflowDefinitionDetail;
    },
  });
}

export function useCreateDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      version: string;
      definition: unknown;
    }): Promise<WorkflowDefinitionDetail> =>
      unwrap(await api.POST("/api/v1/definitions", { body: input as never })) as WorkflowDefinitionDetail,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["definitions"] }),
  });
}

export function useUpdateDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: number;
      version?: string;
      definition?: unknown;
    }): Promise<WorkflowDefinitionDetail> =>
      unwrap(
        await api.PUT("/api/v1/definitions/{id}", {
          params: { path: { id: input.id } },
          body: { version: input.version, definition: input.definition } as never,
        })
      ) as WorkflowDefinitionDetail,
    onSuccess: (_data, input) => {
      qc.invalidateQueries({ queryKey: ["definitions"] });
      qc.invalidateQueries({ queryKey: ["definition", input.id] });
    },
  });
}

export function usePublishDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number): Promise<WorkflowDefinitionDetail> =>
      unwrap(
        await api.POST("/api/v1/definitions/{id}/publish", { params: { path: { id } } })
      ) as WorkflowDefinitionDetail,
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["definitions"] });
      qc.invalidateQueries({ queryKey: ["definition", id] });
    },
  });
}

export function useImportDefinitions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (items: ImportItem[]): Promise<{ imported: number }> =>
      // The generated request body type for this endpoint is `Record<string,
      // never>[]` — openapi-typescript's rendering of a bare `items: object`
      // schema with no properties declared, since Task 4b only tightened the
      // *response* schemas for this task's endpoints (see the ruling in
      // task-9-report.md). ImportItem[] cannot satisfy "every key maps to
      // never", so the cast bridges that schema gap, not a real shape
      // mismatch — the server does accept named fields on each item. The
      // response side needs no cast: the inline `{ imported: number }` 201
      // schema already matches this function's return type exactly.
      unwrap(await api.POST("/api/v1/definitions/import", { body: items as never })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["definitions"] }),
  });
}
