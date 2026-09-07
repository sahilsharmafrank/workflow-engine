import { WfeError } from "../errors";
import { MemoryQueueDriver } from "./memory-driver";
import { QueueDriver, QueueDriverFactory, QueueDriverOptions } from "./types";

const factories = new Map<string, QueueDriverFactory>();

export function registerQueueDriver(name: string, factory: QueueDriverFactory): void {
  if (factories.has(name)) {
    throw new WfeError(`Queue driver "${name}" is already registered`, {
      statusCode: 409, code: "QUEUE_DRIVER_DUPLICATE",
    });
  }
  factories.set(name, factory);
}

export function createQueueDriver(name: string, options: QueueDriverOptions): QueueDriver {
  const factory = factories.get(name);
  if (!factory) {
    throw new WfeError(
      `Unknown queue driver "${name}". Registered drivers: ${[...factories.keys()].join(", ") || "none"}`,
      { statusCode: 400, code: "QUEUE_DRIVER_UNKNOWN" }
    );
  }
  return factory(options);
}

export function listQueueDrivers(): string[] {
  return [...factories.keys()];
}

registerQueueDriver("memory", () => new MemoryQueueDriver());
