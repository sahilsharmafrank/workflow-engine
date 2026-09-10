import { Navigate, RouteObject } from "react-router-dom";
import { AppShell } from "./AppShell";
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
    ],
  },
];
