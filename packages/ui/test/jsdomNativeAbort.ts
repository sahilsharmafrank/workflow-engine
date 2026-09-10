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
 * DOM implementation. Used by test/setup.ts to bridge foreign (jsdom)
 * signals onto native ones — see the comment there for why a plain global
 * swap doesn't work.
 */
export function getNativeAbort(): NativeAbortStash {
  const stash = (globalThis as Record<string, unknown>)[STASH] as NativeAbortStash | undefined;
  if (!stash) {
    throw new Error("Native AbortController not captured yet — did the jsdom-native-abort environment run?");
  }
  return stash;
}

/**
 * Wraps Vitest's built-in "jsdom" environment purely to capture Node's
 * native AbortController/AbortSignal before jsdom's setup() shadows them
 * on `global` with its own DOM implementation. It does NOT restore them —
 * jsdom's own EventTarget#addEventListener brand-checks an options.signal
 * against its own AbortSignal class, so swapping the global class the
 * other way just breaks that path instead (confirmed empirically; see
 * test/jsdomNativeAbort.test.ts). Native/foreign signals are reconciled
 * instead at the one place that needs the native brand: the patched
 * `Request` constructor in test/setup.ts.
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
