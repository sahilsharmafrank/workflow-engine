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
  /** Incremented by core when chaining a delay longer than the driver allows. */
  attempt?: number;
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
