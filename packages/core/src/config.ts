export interface EngineConfig {
  dbUrl: string;
  showSql?: boolean;
  expressionTimeoutMs?: number;
  /**
   * User-supplied values an embedding application wants expressions to be
   * able to read via `config.*`. This is a map maintained separately from
   * the rest of EngineConfig — dbUrl and every other engine-internal field
   * are structurally unreachable from expressions, not merely excluded by
   * convention or by an allowlist that could be misconfigured.
   */
  expressionValues?: Record<string, unknown>;
  /** Allowlist filtering `expressionValues`; keys not listed here stay hidden. */
  expressionConfigKeys?: string[];
  /**
   * How long `RunRepository.saveChecked` will wait on a contended row's lock
   * before Postgres raises `lock_not_available` (55P03). A pooled connection
   * blocked here without a bound can, under redelivery-driven contention,
   * hold a connection indefinitely and stall unrelated work sharing the pool.
   * Defaults to a few seconds.
   */
  lockTimeoutMs?: number;
  /**
   * Whether `core.http` may target private, loopback, link-local, or
   * unique-local addresses (e.g. `127.0.0.1`, `10.0.0.0/8`, the cloud
   * metadata address `169.254.169.254`). Defaults to false: a workflow
   * definition is untrusted input (see README §Definition sandbox), so by
   * default `core.http` refuses to reach internal services on the
   * operator's behalf. Populated here via `isHttpAllowPrivateHosts` purely
   * for visibility alongside the rest of `EngineConfig` — `HttpStep` itself
   * calls that function directly (see http-step.ts), since steps only ever
   * see the allowlisted `expressionValues` subset of this config via
   * `ctx.config`, never the full `EngineConfig`.
   */
  httpAllowPrivateHosts?: boolean;
  /**
   * Largest `depth` a run created via core.subWorkflow may have (0 = a
   * normally-started run, parent.depth + 1 = each nested child).
   * WorkflowManager.startWorkflow refuses to create a run beyond this with
   * `SUB_WORKFLOW_DEPTH_EXCEEDED`. Without this, a self-starting (or
   * mutually-recursive) definition could recurse without limit — auth is
   * deliberately `none` in v1, so any definition author can trigger it.
   * Defaults to 10.
   */
  maxSubWorkflowDepth?: number;
}

/**
 * Whether `core.http` may target private/loopback/link-local/unique-local
 * addresses. A standalone accessor (not just a field read off a loaded
 * `EngineConfig`) because `HttpStep` has no `EngineConfig` instance to read
 * — steps only ever see `ctx.config`, the allowlisted `expressionValues`
 * subset — so it reads the environment itself, the same way `loadEngineConfig`
 * reads `WFE_SHOW_SQL`.
 */
export function isHttpAllowPrivateHosts(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WFE_HTTP_ALLOW_PRIVATE_HOSTS === "true";
}

export function loadEngineConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const dbUrl = env.WFE_DB_URL;
  if (!dbUrl) {
    throw new Error("WFE_DB_URL is required");
  }

  let expressionTimeoutMs = 100;
  if (env.WFE_EXPRESSION_TIMEOUT_MS !== undefined) {
    const parsed = Number(env.WFE_EXPRESSION_TIMEOUT_MS);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `WFE_EXPRESSION_TIMEOUT_MS must be a finite, positive number of milliseconds; got "${env.WFE_EXPRESSION_TIMEOUT_MS}"`
      );
    }
    expressionTimeoutMs = parsed;
  }

  let lockTimeoutMs = 5000;
  if (env.WFE_LOCK_TIMEOUT_MS !== undefined) {
    const parsed = Number(env.WFE_LOCK_TIMEOUT_MS);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `WFE_LOCK_TIMEOUT_MS must be a finite, positive number of milliseconds; got "${env.WFE_LOCK_TIMEOUT_MS}"`
      );
    }
    lockTimeoutMs = parsed;
  }

  let maxSubWorkflowDepth = 10;
  if (env.WFE_MAX_SUBWORKFLOW_DEPTH !== undefined) {
    const parsed = Number(env.WFE_MAX_SUBWORKFLOW_DEPTH);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        `WFE_MAX_SUBWORKFLOW_DEPTH must be a non-negative integer; got "${env.WFE_MAX_SUBWORKFLOW_DEPTH}"`
      );
    }
    maxSubWorkflowDepth = parsed;
  }

  return {
    dbUrl,
    showSql: env.WFE_SHOW_SQL === "true",
    expressionTimeoutMs,
    expressionConfigKeys: env.WFE_EXPRESSION_CONFIG_KEYS?.split(",").map((k) => k.trim()).filter(Boolean) ?? [],
    lockTimeoutMs,
    httpAllowPrivateHosts: isHttpAllowPrivateHosts(env),
    maxSubWorkflowDepth,
  };
}
