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
  build: {
    outDir: "dist",
    sourcemap: true,
    // @wfe/sdk builds to CommonJS (see packages/sdk/tsconfig.json) because
    // it's also consumed by plain-Node @wfe/core and @wfe/server — that's
    // not something this package can change. npm workspaces links it into
    // node_modules as a symlink, and Vite/Node resolve that symlink to its
    // real path (packages/sdk/dist/...) before this plugin ever sees an id,
    // so the string "node_modules" never appears in it.
    //
    // Vite's bundled CommonJS-interop plugin only runs its CJS analysis
    // (and the runtime-fallback "synthetic named exports" it grants CJS
    // modules it can't fully analyze statically) on files matching
    // `commonjsOptions.include`, which defaults to `[/node_modules/]`. That
    // default silently excludes every file under packages/sdk/dist, so none
    // of it — not even a single directly-assigned export — was ever treated
    // as CommonJS at all; Rollup saw it as a plain, exportless script. That
    // (not, as it first appeared, an inability to trace the dynamic
    // `for...in` loop TypeScript's __exportStar helper uses to re-export
    // dist/status.js's PreFlightCheckActionOutcome enum through dist/index.js)
    // is the real reason `import { PreFlightCheckActionOutcome } from
    // "@wfe/sdk"` in PreFlightCheckEditor.tsx and StepEditor.tsx failed only
    // in `vite build`: those are the only two files in this package that
    // import a real runtime value (as opposed to `import type`) from
    // @wfe/sdk, so they're the only place this default ever got exercised.
    //
    // Extending `include` to also cover packages/sdk/dist restores normal
    // CommonJS handling for it: its statically-assigned export (SDK_NAME)
    // still resolves statically as before, and PreFlightCheckActionOutcome
    // — invisible to static analysis either way — now resolves through
    // Rollup's synthetic-named-exports fallback, a runtime property lookup
    // on the module's real, fully-populated CommonJS `exports` object
    // instead of a static match. That object does have the property (the
    // __exportStar loop puts it there at runtime), so the fallback works.
    // Verified by grepping the built bundle for the enum's real string
    // values ("continue"/"skip"/"fail"), not just a clean build exit code.
    commonjsOptions: {
      include: [/node_modules/, /packages\/sdk\/dist/],
    },
  },
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
