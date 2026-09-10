import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { bridgeSignal, getNativeAbort } from "./jsdomNativeAbort";

describe("bridgeSignal (the discriminator itself)", () => {
  it("returns a genuinely native signal unchanged — proves it recognizes native and skips bridging", () => {
    // Not proven via Request/fetch: Node's native Request/fetch do not
    // preserve `.signal` identity even for an already-native input (see
    // the comment on `bridgeSignal`), so asserting identity through them
    // would fail regardless of whether the discriminator is correct.
    // Testing the discriminator directly avoids that confound.
    const { AbortController: NativeAbortController } = getNativeAbort();
    const controller = new NativeAbortController();

    expect(bridgeSignal(controller.signal)).toBe(controller.signal);
  });

  it("returns undefined/null unchanged", () => {
    expect(bridgeSignal(undefined)).toBeUndefined();
    expect(bridgeSignal(null)).toBeNull();
  });

  it("bridges a foreign (jsdom) signal onto a new native one and propagates abort", () => {
    // Plain `new AbortController()` always resolves to jsdom's shadowed
    // class in this environment; this is exactly what library code (not
    // just this test) will call. If the discriminator merely dropped the
    // signal instead of bridging it, the returned signal would never
    // reflect the original's abort — the silent-failure shape this test
    // exists to rule out.
    const controller = new AbortController();
    const bridged = bridgeSignal(controller.signal);

    expect(bridged).not.toBe(controller.signal);
    expect(bridged?.aborted).toBe(false);

    controller.abort();
    expect(bridged?.aborted).toBe(true);
  });

  it("bridges a foreign signal that is already aborted", () => {
    const controller = new AbortController();
    controller.abort("already gone");

    const bridged = bridgeSignal(controller.signal);
    expect(bridged?.aborted).toBe(true);
  });
});

describe("Request/fetch integration", () => {
  it("keeps a genuinely native AbortSignal working through Request", () => {
    const { AbortController: NativeAbortController } = getNativeAbort();
    const controller = new NativeAbortController();
    const request = new Request("http://localhost/api/v1/runs", { signal: controller.signal });

    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it("bridges an ordinary (jsdom) AbortController through Request so abort() still reaches it", () => {
    const controller = new AbortController();
    const request = new Request("http://localhost/api/v1/runs", { signal: controller.signal });

    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it("bridges a bare fetch(url, { signal }) call so an ordinary AbortController can actually cancel an in-flight request", async () => {
    // The gap a `Request`-only patch leaves open: native fetch does not go
    // through `globalThis.Request` at all, so it needs its own patch.
    // Proven end-to-end, not just "doesn't throw": a real in-flight request
    // against a server that never responds, cancelled by an ordinary
    // (jsdom) AbortController, must actually reject.
    const server = createServer(() => {
      // Deliberately never respond, so the request stays in-flight until aborted.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      server.close();
    }
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
