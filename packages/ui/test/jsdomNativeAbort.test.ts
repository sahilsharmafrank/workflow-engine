import { describe, expect, it } from "vitest";
import { getNativeAbort } from "./jsdomNativeAbort";

describe("jsdomNativeAbort", () => {
  it("keeps a genuinely native AbortSignal working through Request unmodified", () => {
    const { AbortController: NativeAbortController } = getNativeAbort();
    const controller = new NativeAbortController();
    const request = new Request("http://localhost/api/v1/runs", { signal: controller.signal });

    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it("bridges an ordinary (jsdom) AbortController — what TanStack Query, MSW, and React Router actually create — so abort() still reaches the native Request", () => {
    // Plain `new AbortController()` always resolves to jsdom's shadowed
    // class in this environment; this is exactly what library code (not
    // just this test) will call. If setup.ts's patch merely dropped the
    // signal instead of bridging it, this Request would construct
    // successfully but `request.signal.aborted` would never become true —
    // the silent-failure shape this test exists to rule out.
    const controller = new AbortController();
    const request = new Request("http://localhost/api/v1/runs", { signal: controller.signal });

    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it("does not break jsdom's own AddEventListenerOptions.signal support", () => {
    // Guards the mirror-image regression: an earlier version of this fix
    // restored the native class as the *global* AbortController, which
    // broke jsdom's internal brand-check for `addEventListener`'s `signal`
    // option (it expects its own AbortSignal class, not the native one).
    const controller = new AbortController();
    let calls = 0;
    document.addEventListener("click", () => calls++, { signal: controller.signal });

    document.dispatchEvent(new Event("click"));
    expect(calls).toBe(1);

    controller.abort();
    document.dispatchEvent(new Event("click"));
    expect(calls).toBe(1);
  });
});
