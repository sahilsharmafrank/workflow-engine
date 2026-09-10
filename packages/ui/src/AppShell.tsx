import { AppBar, Box, Drawer, List, ListItemButton, ListItemText, Toolbar, Typography } from "@mui/material";
import { Component, ErrorInfo, ReactNode } from "react";
import { Link as RouterLink, Outlet, useLocation } from "react-router-dom";

const NAV = [
  { label: "Runs", to: "/runs" },
  { label: "Definitions", to: "/definitions" },
  { label: "Batch jobs", to: "/batch-jobs" },
  { label: "Step catalog", to: "/step-types" },
];

const DRAWER_WIDTH = 200;

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI crashed", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <Box sx={{ p: 3 }}>
          <Typography variant="h6">Something went wrong</Typography>
          <Typography variant="body2">{this.state.error.message}</Typography>
        </Box>
      );
    }
    return this.props.children;
  }
}

export function AppShell() {
  const { pathname } = useLocation();
  return (
    <Box sx={{ display: "flex" }}>
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Toolbar>
          <Typography variant="h6">Workflow Engine</Typography>
        </Toolbar>
      </AppBar>
      <Drawer
        variant="permanent"
        sx={{ width: DRAWER_WIDTH, [`& .MuiDrawer-paper`]: { width: DRAWER_WIDTH, boxSizing: "border-box" } }}
      >
        <Toolbar />
        <List>
          {NAV.map((item) => (
            <ListItemButton
              key={item.to}
              component={RouterLink}
              to={item.to}
              selected={pathname.startsWith(item.to)}
            >
              <ListItemText primary={item.label} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, p: 3 }}>
        <Toolbar />
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </Box>
    </Box>
  );
}
