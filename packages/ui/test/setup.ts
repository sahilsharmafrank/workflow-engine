import "@testing-library/jest-dom/vitest";

/**
 * Vitest's jsdom environment installs jsdom's own AbortController/AbortSignal
 * as globals, but leaves `fetch`/`Request`/`Response` as Node's native
 * (undici) implementations. React Router's data routers (createMemoryRouter,
 * createBrowserRouter — used from Task 1 on) build a `Request` on every
 * navigation, even when no route defines a loader. Node's Request brand-checks
 * RequestInit.signal against undici's own AbortSignal class and throws for
 * jsdom's, which aborts the navigation before it commits.
 *
 * None of our routes read that signal (no loaders/actions), so it is safe to
 * drop it before delegating to the real constructor. See
 * https://github.com/remix-run/react-router/issues/10517 and
 * https://github.com/nodejs/undici/issues/1935.
 */
const NativeRequest = globalThis.Request;
class TestRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init?.signal) {
      const { signal: _droppedJsdomSignal, ...rest } = init;
      super(input, rest);
    } else {
      super(input, init);
    }
  }
}
globalThis.Request = TestRequest as unknown as typeof Request;
