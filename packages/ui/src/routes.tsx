import { Navigate, RouteObject } from "react-router-dom";
import { AppShell } from "./AppShell";
import { BatchJobDetail } from "./screens/BatchJobDetail";
import { BatchJobs } from "./screens/BatchJobs";
import { DefinitionDetail } from "./screens/DefinitionDetail";
import { DefinitionEditor } from "./screens/DefinitionEditor";
import { Definitions } from "./screens/Definitions";
import { RunDetail } from "./screens/RunDetail";
import { RunTracker } from "./screens/RunTracker";
import { StepCatalog } from "./screens/StepCatalog";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/runs" replace /> },
      { path: "runs", element: <RunTracker /> },
      { path: "runs/:id", element: <RunDetail /> },
      { path: "step-types", element: <StepCatalog /> },
      { path: "definitions", element: <Definitions /> },
      { path: "definitions/new", element: <DefinitionEditor /> },
      { path: "definitions/:id", element: <DefinitionDetail /> },
      { path: "definitions/:id/edit", element: <DefinitionEditor /> },
      { path: "batch-jobs", element: <BatchJobs /> },
      { path: "batch-jobs/:id", element: <BatchJobDetail /> },
    ],
  },
];
