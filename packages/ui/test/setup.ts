import "@testing-library/jest-dom/vitest";
import { getNativeAbort } from "./jsdomNativeAbort";

/**
 * Vitest's jsdom environment shadows the global AbortController/AbortSignal
 * with jsdom's own DOM implementation, but leaves `fetch`/`Request`/
 * `Response` as Node's native (undici) implementations, since jsdom doesn't
 * implement those itself. Node's native `Request` brand-checks
 * `RequestInit.signal` against undici's own AbortSignal class via
 * `instanceof` and throws for jsdom's — even though it's a spec-faithful
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
 * depending on the consumer.
 *
 * So: leave the global AbortController as jsdom's (DOM APIs keep working),
 * and bridge only at the native fetch/Request boundary — mirror a foreign
 * (jsdom) signal onto a genuinely native one before handing it to the real
 * Request constructor. Aborting the original jsdom controller (e.g.
 * TanStack Query calling `controller.abort()`) still flips the native
 * request's signal, so cancellation semantics survive in both directions;
 * nothing is silently dropped. See
 * https://github.com/remix-run/react-router/issues/10517 and
 * https://github.com/nodejs/undici/issues/1935.
 */
const NativeRequest = globalThis.Request;
const { AbortController: NativeAbortController, AbortSignal: NativeAbortSignal } = getNativeAbort();

class TestRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const signal = init?.signal;
    // Checked via an intermediate boolean, not an inline `instanceof` in the
    // `if`: TS's control-flow narrowing otherwise treats `NativeAbortSignal`
    // as nominally identical to the declared `AbortSignal` type (they share
    // the same lib.dom.d.ts type even though they're different runtime
    // classes here) and narrows `signal` to `never` inside the branch.
    const isForeignSignal = signal != null && !(signal instanceof NativeAbortSignal);
    if (isForeignSignal) {
      const foreignSignal = signal as AbortSignal;
      const bridge = new NativeAbortController();
      if (foreignSignal.aborted) {
        bridge.abort((foreignSignal as { reason?: unknown }).reason);
      } else {
        foreignSignal.addEventListener(
          "abort",
          () => bridge.abort((foreignSignal as { reason?: unknown }).reason),
          { once: true }
        );
      }
      super(input, { ...init, signal: bridge.signal });
    } else {
      super(input, init);
    }
  }
}
globalThis.Request = TestRequest as unknown as typeof Request;
