import type { Environment } from "vitest";
import { builtinEnvironments } from "vitest/environments";

const jsdom = builtinEnvironments.jsdom;

// Vitest loads a custom `test.environment` module through a separate
// module graph from the one used for the test file and its setupFiles, so
// a plain module-scope variable set here would not be visible from
// test/setup.ts — they'd be two different instantiations of this file.
// `globalThis` is the one thing genuinely shared across both, since both
// run in the same worker process.
const STASH = "__wfeNativeAbort__" as const;

interface NativeAbortStash {
  AbortController: typeof AbortController;
  AbortSignal: typeof AbortSignal;
}

/**
 * The real, unshadowed AbortController/AbortSignal, captured the instant
 * before jsdom's setup() overwrites `global.AbortController` with its own
 * DOM implementation. Used to bridge foreign (jsdom) signals onto native
 * ones — see the comment on `bridgeSignal` and in test/setup.ts for why a
 * plain global swap doesn't work.
 */
export function getNativeAbort(): NativeAbortStash {
  const stash = (globalThis as Record<string, unknown>)[STASH] as NativeAbortStash | undefined;
  if (!stash) {
    throw new Error("Native AbortController not captured yet — did the jsdom-native-abort environment run?");
  }
  return stash;
}

/**
 * Returns a native-brand AbortSignal equivalent to `signal`.
 *
 * A signal that is already native (or absent) is returned **unchanged** —
 * this is the discriminator, and it's exported and tested directly (see
 * test/jsdomNativeAbort.test.ts) rather than proven indirectly through
 * `Request`/`fetch`, because Node's native `Request`/`fetch` do not
 * preserve `.signal` identity even for an already-native input (confirmed
 * empirically: `new Request(url, { signal }).signal !== signal` is true
 * even with zero patching involved — they compose their own internal
 * signal regardless). That's an unrelated undici implementation detail;
 * testing `bridgeSignal` in isolation avoids being confounded by it.
 *
 * A foreign (jsdom) signal is mirrored onto a fresh native
 * AbortController: already aborted if the foreign signal already is,
 * otherwise wired to abort — with the same reason — when the foreign
 * signal does.
 */
export function bridgeSignal(signal: AbortSignal | null | undefined): AbortSignal | null | undefined {
  const { AbortController: NativeAbortController, AbortSignal: NativeAbortSignal } = getNativeAbort();

  // Checked via an intermediate boolean, not an inline `instanceof` in the
  // `if`: TS's control-flow narrowing otherwise treats `NativeAbortSignal`
  // as nominally identical to the declared `AbortSignal` type (they share
  // the same lib.dom.d.ts type even though they're different runtime
  // classes here) and narrows `signal` to `never` inside the branch.
  const isForeignSignal = signal != null && !(signal instanceof NativeAbortSignal);
  if (!isForeignSignal) {
    return signal;
  }
  const foreignSignal = signal as AbortSignal;
  const bridge = new NativeAbortController();
  if (foreignSignal.aborted) {
    bridge.abort((foreignSignal as { reason?: unknown }).reason);
  } else {
    // This listener is never removed if the foreign signal never aborts.
    // Fine at test-suite scale — every foreign signal here is created and
    // discarded within a single test — but do not copy this into anything
    // longer-lived without adding cleanup (e.g. an `AbortController` of
    // your own to unregister it).
    foreignSignal.addEventListener(
      "abort",
      () => bridge.abort((foreignSignal as { reason?: unknown }).reason),
      { once: true }
    );
  }
  return bridge.signal;
}

/**
 * Wraps Vitest's built-in "jsdom" environment purely to capture Node's
 * native AbortController/AbortSignal before jsdom's setup() shadows them
 * on `global` with its own DOM implementation. It does NOT restore them —
 * jsdom's own EventTarget#addEventListener brand-checks an options.signal
 * against its own AbortSignal class, so swapping the global class the
 * other way just breaks that path instead (confirmed empirically; see
 * test/jsdomNativeAbort.test.ts). Native/foreign signals are reconciled
 * instead at the boundaries that need the native brand — `Request` and
 * `fetch`, both patched in test/setup.ts via `bridgeSignal` above.
 */
const environment: Environment = {
  name: "jsdom-native-abort",
  transformMode: "web",
  async setup(global, options) {
    (globalThis as Record<string, unknown>)[STASH] = {
      AbortController: global.AbortController,
      AbortSignal: global.AbortSignal,
    } satisfies NativeAbortStash;
    return jsdom.setup(global, options);
  },
};

export default environment;
