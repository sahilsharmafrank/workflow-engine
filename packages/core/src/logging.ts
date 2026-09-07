import { Logger, LogFields } from "@wfe/sdk";
import pino from "pino";

const root = pino({ level: process.env.WFE_LOG_LEVEL ?? "info" });

export function createLogger(name: string): Logger {
  const child = root.child({ component: name });
  return {
    debug: (message: string, fields?: LogFields) => child.debug(fields ?? {}, message),
    info: (message: string, fields?: LogFields) => child.info(fields ?? {}, message),
    warn: (message: string, fields?: LogFields) => child.warn(fields ?? {}, message),
    error: (message: string, fields?: LogFields) => child.error(fields ?? {}, message),
  };
}
