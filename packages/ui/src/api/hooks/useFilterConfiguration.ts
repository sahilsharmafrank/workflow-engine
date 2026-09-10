import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../client";

export interface FilterField {
  field: string;
  type: "enum" | "text" | "dateRange";
  values?: string[];
}

export interface FilterConfiguration {
  definitions: FilterField[];
  runs: FilterField[];
  steps: FilterField[];
}

export function useFilterConfiguration() {
  return useQuery({
    queryKey: ["filter-configuration"],
    // Filter descriptors change only when the registry does, which needs a
    // server restart — so this is worth caching for the session.
    staleTime: Infinity,
    // The generated schema documents this endpoint with no response body
    // (`content?: never` in schema.d.ts) even though the server actually
    // returns a JSON object — a gap in the server's OpenAPI annotations,
    // out of scope for this task. `unwrap`'s inferred T is therefore
    // `undefined`, which doesn't overlap with FilterConfiguration enough
    // for a direct cast; going through `unknown` is what TS itself
    // suggests for a deliberate cast like this one.
    queryFn: async (): Promise<FilterConfiguration> =>
      unwrap(await api.GET("/api/v1/filter-configuration", {})) as unknown as FilterConfiguration,
  });
}
