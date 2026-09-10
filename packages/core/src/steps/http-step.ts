import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { BaseStep, RunStepResponse, StepContext, WorkflowStatus } from "@wfe/sdk";
import { isHttpAllowPrivateHosts } from "../config";
import { WfeError } from "../errors";

// Response bodies are read fully into memory (JSON.parse'd or concatenated
// into a string), so an uncapped read is itself a resource-exhaustion vector
// against the worker process, independent of the SSRF concern below.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MiB

// Redirects are followed manually, in HttpStep.run's own loop, rather than
// left to fetch's default `redirect: "follow"`: a public URL that 302s to a
// blocked address must be caught too, not just the URL the definition author
// typed in. Capped so a redirect loop (or a chain crafted to run it out)
// can't hang a step indefinitely.
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isBlockedIPv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false; // not a well-formed dotted-quad; nothing here to block
  }
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 — "this network"; on Linux, connecting to 0.0.0.0 reaches localhost
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 10) return true; // 10.0.0.0/8 — private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local, covers the cloud metadata address 169.254.169.254
  return false;
}

/**
 * Parses a syntactically valid IPv6 literal (as accepted by `isIP`) into its
 * 16 bytes, expanding "::" compression and an embedded IPv4 dotted-quad tail
 * (the "::ffff:a.b.c.d" and deprecated "::a.b.c.d" forms). This is the only
 * place in the module that looks at IPv6 as text — every blocking decision
 * below is made over the returned bytes, not the string, so a new textual
 * form the URL/DNS layer might hand back (compressed, expanded, mixed) can't
 * slip past the guard the way the old text regex did.
 *
 * Returns null if the text can't be parsed as a well-formed IPv6 literal.
 * Callers MUST treat a null result as blocked, not allowed.
 */
function parseIPv6Bytes(address: string): Uint8Array | null {
  let text = address;

  // Rewrite a trailing IPv4 dotted-quad ("...:a.b.c.d") into two hex groups
  // so the rest of the parser only ever deals with colon-separated hex.
  const dotIndex = text.indexOf(".");
  if (dotIndex !== -1) {
    const lastColon = text.lastIndexOf(":");
    if (lastColon === -1 || lastColon > dotIndex) return null;
    const octets = text.slice(lastColon + 1).split(".");
    if (octets.length !== 4) return null;
    const nums: number[] = [];
    for (const o of octets) {
      if (!/^\d{1,3}$/.test(o)) return null;
      const n = Number(o);
      if (n < 0 || n > 255) return null;
      nums.push(n);
    }
    const hi = ((nums[0] << 8) | nums[1]).toString(16);
    const lo = ((nums[2] << 8) | nums[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const groups = s.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const halves = text.split("::");
  let groups: number[] | null;
  if (halves.length === 2) {
    const head = parseGroups(halves[0]);
    const tail = parseGroups(halves[1]);
    if (head === null || tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail];
  } else if (halves.length === 1) {
    groups = parseGroups(halves[0]);
    if (groups !== null && groups.length !== 8) return null;
  } else {
    return null; // more than one "::" — not a valid IPv6 literal
  }
  if (groups === null || groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

function isBlockedIPv6(ip: string): boolean {
  const bytes = parseIPv6Bytes(ip.toLowerCase());
  if (!bytes) return true; // couldn't determine what this is — block, not allow

  if (bytes.every((b) => b === 0)) return true; // :: — unspecified address
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1 — loopback

  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
    // IPv4-mapped IPv6, ::ffff:0:0/96 — decide from the embedded IPv4
    // address rather than re-deriving the IPv4 ranges here.
    return isBlockedIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  if (bytes.slice(0, 12).every((b) => b === 0)) {
    // IPv4-compatible IPv6 (deprecated), ::/96 — same treatment. :: and
    // ::1 are special cases of this same prefix and are already handled
    // above, so anything reaching here has a genuine embedded address.
    return isBlockedIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 — unique-local
  // Not named in the literal list of ranges this fix was scoped to, but the
  // same "link-local" rationale that covers 169.254.0.0/16 for IPv4 applies
  // here: fe80::/10 is IPv6's link-local range and reaches the same class of
  // on-link metadata services.
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 — link-local

  return false;
}

function isBlockedAddress(address: string, family: number): boolean {
  return family === 6 ? isBlockedIPv6(address) : isBlockedIPv4(address);
}

/**
 * Refuses a request whose target resolves to a private, loopback,
 * link-local, or unique-local address, unless WFE_HTTP_ALLOW_PRIVATE_HOSTS
 * has opted the deployment out. Called for the initial URL and again for
 * every redirect hop.
 *
 * Residual gap (DNS rebinding): this resolves and validates the hostname via
 * `dns.lookup` itself, but the `fetch()` call that follows performs its own,
 * independent DNS resolution when it actually opens the connection. A
 * narrow window exists between the two lookups in which a malicious or
 * compromised DNS server could rebind the name to a blocked address after
 * this check passes, and `fetch` would then connect to it anyway. Closing
 * that fully would require pinning the address this function validated into
 * the socket `fetch` opens (e.g. a custom undici dispatcher with a
 * `connect` override that forces the validated address while preserving the
 * TLS SNI/Host header) — out of scope for this fix. A literal IP in the URL
 * (nothing to rebind) is not subject to this gap.
 */
async function assertHostAllowed(urlStr: string): Promise<void> {
  if (isHttpAllowPrivateHosts()) return;

  const target = new URL(urlStr);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true });

  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      throw new WfeError(
        `core.http refused to request "${urlStr}": ${hostname} resolves to ${address}, a private/loopback/link-local address`,
        { statusCode: 400, code: "HTTP_STEP_BLOCKED_HOST" }
      );
    }
  }
}

/** Reads a response body up to `maxBytes`, refusing to buffer past it. */
async function readCappedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WfeError(
          `core.http response exceeded the ${maxBytes}-byte cap`,
          { statusCode: 502, code: "HTTP_STEP_RESPONSE_TOO_LARGE" }
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export class HttpStep extends BaseStep {
  async run(ctx: StepContext): Promise<RunStepResponse> {
    const {
      url,
      method = "GET",
      headers = {},
      body,
      retries = 0,
      backoffMs = 1000,
      timeoutMs = 30000,
    } = ctx.inputs as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      retries?: number;
      backoffMs?: number;
      timeoutMs?: number;
    };

    if (!url) {
      throw new WfeError("core.http requires a url input", {
        statusCode: 400,
        code: "HTTP_STEP_MISSING_URL",
      });
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const fetchHeaders: Record<string, string> = { ...headers };
        if (attempt > 0) {
          fetchHeaders["x-attempt"] = String(attempt + 1);
        }

        let requestMethod = method.toUpperCase();
        let requestBody: string | undefined;
        if (body !== undefined && requestMethod !== "GET" && requestMethod !== "HEAD") {
          requestBody = typeof body === "string" ? body : JSON.stringify(body);
          if (!fetchHeaders["content-type"]) {
            fetchHeaders["content-type"] = "application/json";
          }
        }

        const signal = AbortSignal.timeout(timeoutMs);
        let currentUrl = url;
        let response: Response | undefined;

        for (let redirectCount = 0; ; redirectCount++) {
          await assertHostAllowed(currentUrl);

          response = await fetch(currentUrl, {
            method: requestMethod,
            headers: fetchHeaders,
            body: requestMethod === "GET" || requestMethod === "HEAD" ? undefined : requestBody,
            redirect: "manual",
            signal,
          });

          const location = response.headers.get("location");
          if (!REDIRECT_STATUSES.has(response.status) || !location) break;

          if (redirectCount >= MAX_REDIRECTS) {
            throw new Error(`core.http exceeded ${MAX_REDIRECTS} redirects requesting ${url}`);
          }
          currentUrl = new URL(location, currentUrl).toString();
          if (response.status === 303) {
            // 303 always downgrades to a bodyless GET, regardless of the
            // original method — the other redirect statuses preserve both.
            requestMethod = "GET";
            requestBody = undefined;
          }
        }

        if (response.ok) {
          const contentType = response.headers.get("content-type") ?? "";
          const rawBody = await readCappedBody(response, MAX_RESPONSE_BYTES);
          const responseBody: unknown = contentType.includes("application/json") && rawBody
            ? JSON.parse(rawBody)
            : rawBody;

          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((v, k) => { responseHeaders[k] = v; });

          ctx.step.outputs = { status: response.status, headers: responseHeaders, body: responseBody };
          ctx.step.status = WorkflowStatus.COMPLETE;
          return { stepState: ctx.step };
        }

        const errorBody = await readCappedBody(response, MAX_RESPONSE_BYTES);
        lastError = new Error(`HTTP ${response.status}: ${errorBody}`);
      } catch (err) {
        if (err instanceof WfeError && err.code === "HTTP_STEP_BLOCKED_HOST") {
          throw err; // not retryable: retrying doesn't change where the target resolves
        }
        lastError = err as Error;
      }
    }

    throw new WfeError(
      `core.http request to ${url} failed after ${retries + 1} attempt(s): ${lastError?.message}`,
      { statusCode: 502, code: "HTTP_STEP_FAILED", cause: lastError },
    );
  }
}
