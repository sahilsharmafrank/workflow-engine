import { EngineConfig, loadEngineConfig } from "@wfe/core";

export interface ServerConfig extends EngineConfig {
  port: number;
  authProvider: string;
  queueDriver: string;
  queueUrl?: string;
  sqsPrefix?: string;
  awsRegion?: string;
  servicesConfig: Record<string, string>;
  plugins: string[];
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const engine = loadEngineConfig(env);

  let servicesConfig: Record<string, string> = {};
  if (env.WFE_SERVICES) {
    try {
      servicesConfig = JSON.parse(env.WFE_SERVICES);
    } catch {
      throw new Error(`WFE_SERVICES must be valid JSON; got: ${env.WFE_SERVICES}`);
    }
  }

  return {
    ...engine,
    port: Number(env.WFE_PORT ?? 3000),
    authProvider: env.WFE_AUTH_PROVIDER ?? "none",
    queueDriver: env.WFE_QUEUE_DRIVER ?? "memory",
    queueUrl: env.WFE_QUEUE_URL,
    sqsPrefix: env.WFE_SQS_PREFIX,
    awsRegion: env.WFE_AWS_REGION ?? env.AWS_REGION,
    servicesConfig,
    plugins: (env.WFE_PLUGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}
