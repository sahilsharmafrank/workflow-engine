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
    // Vitest's builtin jsdom environment defaults its document URL to
    // "http://localhost:3000/", not "http://localhost/" — the origin the
    // MSW handlers and fixtures under test/msw/ standardize on (see
    // test/setup.ts's resolveRelativeUrl). This flows through unchanged:
    // Vitest passes `config.environmentOptions` as the `options` argument
    // to any environment's setup(global, options), and
    // ./test/jsdomNativeAbort.ts forwards that same `options` object
    // straight through to the builtin jsdom environment's own
    // setup(global, { jsdom }), which reads `jsdom.url` from it.
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    globals: true,
    setupFiles: ["./test/setup.ts"],
    // Contract tests start Postgres containers and are slow; they opt in
    // to a longer timeout individually.
    testTimeout: 10000,
  },
});
