import { Navigate, RouteObject } from "react-router-dom";
import { AppShell } from "./AppShell";
import { RunTracker } from "./screens/RunTracker";
import { StepCatalog } from "./screens/StepCatalog";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/runs" replace /> },
      { path: "runs", element: <RunTracker /> },
      { path: "step-types", element: <StepCatalog /> },
    ],
  },
];
