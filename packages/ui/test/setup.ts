import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach } from "vitest";
import { bridgeSignal } from "./jsdomNativeAbort";
import { mswServer } from "./msw/server";

/**
 * Vitest's jsdom environment shadows the global AbortController/AbortSignal
 * with jsdom's own DOM implementation, but leaves `fetch`/`Request`/
 * `Response` as Node's native (undici) implementations, since jsdom doesn't
 * implement those itself. Node's native `Request` — and, separately, native
 * `fetch` itself, which does NOT go through `globalThis.Request` at all —
 * brand-check `RequestInit.signal` against undici's own AbortSignal class
 * via `instanceof` and throw for jsdom's, even though it's a spec-faithful
 * AbortSignal.
 *
 * That matters beyond this task's own tests: React Router's data routers
 * build a `Request` on every navigation, and from Task 3 on, TanStack Query
 * and MSW both create AbortControllers to drive cancellation through
 * `fetch`. All of those call plain `new AbortController()`, which always
 * resolves to jsdom's shadowed class — there's no way for library code to
 * reach the native one directly.
 *
 * Restoring the native class as the *global* AbortController instead would
 * just move the incompatibility: jsdom's own EventTarget#addEventListener
 * brand-checks an `options.signal` against its own AbortSignal class, so a
 * native signal would then fail *there* (confirmed empirically — see
 * test/jsdomNativeAbort.test.ts). Both classes are legitimately needed
 * depending on the consumer, so the global stays jsdom's and bridging
 * happens only at the two boundaries below. See `bridgeSignal` in
 * ./jsdomNativeAbort.ts for how, and
 * https://github.com/remix-run/react-router/issues/10517 and
 * https://github.com/nodejs/undici/issues/1935 for the upstream reports.
 *
 * Coverage, verified empirically (see test/jsdomNativeAbort.test.ts):
 *  - `new Request(url, { signal })` — bridged directly, below.
 *  - Bare `fetch(url, { signal })` — bridged directly, below. This is the
 *    call shape a `Request`-only patch does NOT cover: native fetch builds
 *    its own internal request representation without going through
 *    `globalThis.Request`, so without this second patch a plain
 *    `fetch(url, { signal: someJsdomController.signal })` still throws.
 *  - MSW's `setupServer(...).listen()` (Task 3+): its FetchInterceptor
 *    captures whatever `globalThis.fetch` currently is as its "passthrough"
 *    target at listen()-time (`@mswjs/interceptors/src/interceptors/fetch/
 *    index.ts`, `const pureFetch = globalThis.fetch`), and separately
 *    constructs its own internal request via a `FetchRequest extends
 *    Request` class. Because Vitest's `setupFiles` run to completion as a
 *    distinct, earlier phase — before the test file's own module graph
 *    (wherever it imports `msw/node`) is ever evaluated — both resolve
 *    `Request`/`fetch` to the patched versions here, regardless of whether
 *    Task 3 wires msw into this file or a separate one. Verified by
 *    invoking `setupServer().listen()` and calling `fetch(url, { signal:
 *    new AbortController().signal })` against an intercepted, unhandled
 *    request: it passes through msw's interceptor and reaches the real
 *    network layer (a normal connection-refused rejection) instead of
 *    throwing the brand-check TypeError.
 */
const NativeRequest = globalThis.Request;
const NativeFetch = globalThis.fetch;

/**
 * Task 3 addition, found wiring up the first real HTTP calls in this
 * package: `src/api/client.ts` deliberately uses an empty `openapi-fetch`
 * base URL and calls relative paths like "/api/v1/step-types" — correct in
 * a real browser, where `fetch("/x")` resolves against `window.location`
 * for free. `NativeRequest`/`NativeFetch` above are undici's, though, and
 * undici's `Request`/`fetch` have no notion of a "current document" to
 * resolve a relative URL against — they require an absolute URL
 * unconditionally and throw `TypeError: Failed to parse URL from /x`
 * otherwise (confirmed empirically, both via `new Request("/x")` directly
 * and via a `useStepTypes()` call under MSW: the request never reaches
 * MSW's interceptor at all — it fails building the `Request` before any
 * handler gets a look). jsdom doesn't paper over this because jsdom
 * doesn't implement fetch/Request itself (see the comment above); the
 * resolution browsers do implicitly simply doesn't happen anywhere in
 * this stack unless something does it explicitly. So it happens here,
 * against jsdom's own `location` — pinned to "http://localhost/" via
 * `test.environmentOptions.jsdom.url` in vite.config.ts (Vitest's jsdom
 * environment otherwise defaults to "http://localhost:3000/", which would
 * silently mismatch the "http://localhost" origin every handler in
 * test/msw/handlers.ts and this suite's tests standardize on).
 */
function resolveRelativeUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === "string" && input.startsWith("/")) {
    return new URL(input, location.href).href;
  }
  return input;
}

class TestRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(resolveRelativeUrl(input), init ? { ...init, signal: bridgeSignal(init.signal) } : init);
  }
}
globalThis.Request = TestRequest as unknown as typeof Request;

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  NativeFetch(
    resolveRelativeUrl(input),
    init ? { ...init, signal: bridgeSignal(init.signal) } : init
  )) as typeof fetch;

// "error" rather than "warn": an unhandled request means a screen called an
// endpoint no handler describes, which is exactly the drift this layer exists
// to catch. Letting it through silently would defeat the point.
//
// listen() is called here at top level, NOT inside beforeAll(), and that is
// deliberate: openapi-fetch's createClient() reads `globalThis.fetch` once,
// as a default-parameter value, at createClient()-call time (i.e. when
// src/api/client.ts's module-level `export const api = createClient(...)`
// runs). Vitest fully evaluates a setup file's top-level code — this file
// included — before it resolves the test file's own module graph, so by
// calling listen() here rather than in a beforeAll (which only runs once
// the test file's imports, and therefore client.ts's createClient() call,
// have already resolved) globalThis.fetch is already MSW's patched version
// by the time createClient() captures it. Moving this back into beforeAll
// reopens that gap: the client's `fetch` reference would be captured before
// MSW patches it, and every request would silently escape to the real
// network instead of hitting a handler (confirmed empirically — see
// .superpowers/sdd/2026-09-10-phase5-ui/task-3-report.md).
mswServer.listen({ onUnhandledRequest: "error" });
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
