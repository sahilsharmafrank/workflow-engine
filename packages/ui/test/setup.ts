import "@testing-library/jest-dom/vitest";
import { bridgeSignal } from "./jsdomNativeAbort";

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

class TestRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init ? { ...init, signal: bridgeSignal(init.signal) } : init);
  }
}
globalThis.Request = TestRequest as unknown as typeof Request;

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  NativeFetch(input, init ? { ...init, signal: bridgeSignal(init.signal) } : init)) as typeof fetch;
