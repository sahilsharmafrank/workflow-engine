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
    queryFn: async (): Promise<FilterConfiguration> =>
      unwrap(await api.GET("/api/v1/filter-configuration", {})),
  });
}
