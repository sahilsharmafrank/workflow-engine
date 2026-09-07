export interface EngineConfig {
  dbUrl: string;
  showSql?: boolean;
  expressionTimeoutMs?: number;
  /** Config keys reachable from expressions. Everything else stays hidden. */
  expressionConfigKeys?: string[];
}

export function loadEngineConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const dbUrl = env.WFE_DB_URL;
  if (!dbUrl) {
    throw new Error("WFE_DB_URL is required");
  }
  return {
    dbUrl,
    showSql: env.WFE_SHOW_SQL === "true",
    expressionTimeoutMs: env.WFE_EXPRESSION_TIMEOUT_MS ? Number(env.WFE_EXPRESSION_TIMEOUT_MS) : 100,
    expressionConfigKeys: env.WFE_EXPRESSION_CONFIG_KEYS?.split(",").map((k) => k.trim()).filter(Boolean) ?? [],
  };
}
