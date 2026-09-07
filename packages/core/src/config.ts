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

  return {
    dbUrl,
    showSql: env.WFE_SHOW_SQL === "true",
    expressionTimeoutMs,
    expressionConfigKeys: env.WFE_EXPRESSION_CONFIG_KEYS?.split(",").map((k) => k.trim()).filter(Boolean) ?? [],
  };
}
