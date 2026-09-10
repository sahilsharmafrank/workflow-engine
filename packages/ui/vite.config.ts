import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The app calls /api/v1/... with no host, so in production it is same-origin
    // against @wfe/server. In development Vite proxies those calls to the server
    // running separately on 3000, which keeps the client code identical in both.
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: true },
  test: {
    // Wraps the built-in "jsdom" environment to keep Node's native
    // AbortController/AbortSignal instead of jsdom's — see the comment in
    // ./test/jsdomNativeAbort.ts for why.
    environment: "./test/jsdomNativeAbort.ts",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    // Contract tests start Postgres containers and are slow; they opt in
    // to a longer timeout individually.
    testTimeout: 10000,
  },
});
