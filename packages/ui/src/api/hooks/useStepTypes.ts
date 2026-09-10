import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../client";

export interface StepType {
  type: string;
  version: string;
  description?: string;
}

export function useStepTypes() {
  return useQuery({
    queryKey: ["step-types"],
    queryFn: async (): Promise<StepType[]> =>
      unwrap(await api.GET("/api/v1/step-types", {})) as StepType[],
  });
}
