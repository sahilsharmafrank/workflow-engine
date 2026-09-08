/** The envelope every driver carries. Kept small and JSON-serialisable. */
export interface WorkflowMessage {
  tenantId: string;
  runId: number;
  stepNumber: number;
  /** `resume` continues a suspended step; `callback` carries an external reply. */
  kind: "resume" | "callback";
  /** Payload for a callback; becomes the step's `body`. */
  body?: unknown;
  correlationId?: string;
  /**
   * Delivery attempt counter. Reserved for a driver's own redelivery count
   * (e.g. SQS's `ApproximateReceiveCount`); core does not populate or read
   * it today. Kept distinct from `remainingDelaySeconds` below — the two are
   * different units and must never be conflated, or a redelivered ordinary
   * message would be misread as a chained delay.
   */
  attempt?: number;
  /**
   * Seconds still owed after this hop, set by core when a requested delay
   * exceeded the driver's `maxDelaySeconds` and had to be chained. Greater
   * than zero tells `RunExecutor.resume` to re-publish rather than execute.
   */
  remainingDelaySeconds?: number;
}

export interface QueueDefinition {
  queueName: string;
  /** Default delay applied to every message on this queue, when a driver supports it. */
  delaySeconds?: number;
}

export type Unsubscribe = () => Promise<void>;

export interface QueueDriver {
  readonly name: string;
  /**
   * Largest delay this driver can apply to a single message. Core chains
   * re-enqueues for anything longer, so a driver never has to.
   */
  readonly maxDelaySeconds: number;
  ensureQueues(defs: QueueDefinition[]): Promise<void>;
  publish(queue: string, msg: WorkflowMessage, opts?: { delaySeconds?: number }): Promise<void>;
  /**
   * Delivery is at-least-once: a handler that throws must leave the message
   * for redelivery, and a handler that returns must consume it.
   */
  subscribe(queue: string, handler: (msg: WorkflowMessage) => Promise<void>): Promise<Unsubscribe>;
  close(): Promise<void>;
}

export interface QueueDriverOptions {
  url?: string;
  prefix?: string;
  region?: string;
  [key: string]: unknown;
}

export type QueueDriverFactory = (options: QueueDriverOptions) => QueueDriver;
