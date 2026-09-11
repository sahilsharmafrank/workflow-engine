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

export function useDefinitions(params: { status?: string; name?: string; limit?: number; offset?: number }) {
  return useQuery({
    queryKey: ["definitions", params],
    queryFn: async (): Promise<DefinitionListResult> =>
      // The generated query type narrows `status` to the literal union
      // "draft" | "published" | "archived" (declared in the OpenAPI document
      // for this endpoint only — GET /runs' `status` stays a bare `string`).
      // FilterBar hands back whatever the server's own /filter-configuration
      // enum values are, as plain strings, so this hook's params can't adopt
      // that literal union without coupling to it here. The cast bridges
      // that gap; see task-9-report.md.
      unwrap(await api.GET("/api/v1/definitions", { params: { query: params as never } })) as DefinitionListResult,
  });
}

export function useDefinition(id: number) {
  return useQuery({
    queryKey: ["definition", id],
    queryFn: async (): Promise<WorkflowDefinitionDetail> =>
      unwrap(await api.GET("/api/v1/definitions/{id}", { params: { path: { id } } })) as WorkflowDefinitionDetail,
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
      // mismatch — the server does accept named fields on each item.
      unwrap(await api.POST("/api/v1/definitions/import", { body: items as never })) as { imported: number },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["definitions"] }),
  });
}
