import { Typography } from "@mui/material";
import { Navigate, RouteObject } from "react-router-dom";
import { AppShell } from "./AppShell";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/runs" replace /> },
      // Placeholder — Task 7 replaces this element with <RunTracker />.
      { path: "runs", element: <Typography variant="h5">Runs</Typography> },
    ],
  },
];
