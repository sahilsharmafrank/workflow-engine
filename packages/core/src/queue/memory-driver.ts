import { QueueDefinition, QueueDriver, Unsubscribe, WorkflowMessage } from "./types";

interface Envelope {
  message: WorkflowMessage;
  visibleAt: number;
}

/**
 * In-process driver for tests and single-node development. Time is virtual:
 * `advanceTime` moves the clock so a delay test does not have to sleep, and
 * `drain` runs every message whose delay has elapsed.
 */
export class MemoryQueueDriver implements QueueDriver {
  readonly name = "memory";
  readonly maxDelaySeconds = 900;

  private readonly queues = new Map<string, Envelope[]>();
  private readonly handlers = new Map<string, (msg: WorkflowMessage) => Promise<void>>();
  private now = 0;

  async ensureQueues(defs: QueueDefinition[]): Promise<void> {
    for (const def of defs) {
      if (!this.queues.has(def.queueName)) {
        this.queues.set(def.queueName, []);
      }
    }
  }

  async publish(queue: string, msg: WorkflowMessage, opts?: { delaySeconds?: number }): Promise<void> {
    const envelopes = this.queues.get(queue) ?? [];
    envelopes.push({
      message: { ...msg },
      visibleAt: this.now + (opts?.delaySeconds ?? 0) * 1000,
    });
    this.queues.set(queue, envelopes);
  }

  async subscribe(queue: string, handler: (msg: WorkflowMessage) => Promise<void>): Promise<Unsubscribe> {
    this.handlers.set(queue, handler);
    return async () => {
      this.handlers.delete(queue);
    };
  }

  /** Virtual clock: move time forward so delayed messages become visible. */
  advanceTime(ms: number): void {
    this.now += ms;
  }

  /**
   * Delivers every currently-visible message once. A handler that throws leaves
   * its message queued for the next drain — at-least-once, as the interface says.
   */
  async drain(): Promise<void> {
    for (const [queue, envelopes] of this.queues) {
      const handler = this.handlers.get(queue);
      if (!handler) continue;

      const ready = envelopes.filter((e) => e.visibleAt <= this.now);
      const notReady = envelopes.filter((e) => e.visibleAt > this.now);
      const failed: Envelope[] = [];

      for (const envelope of ready) {
        try {
          await handler(envelope.message);
        } catch {
          failed.push(envelope);
        }
      }
      this.queues.set(queue, [...notReady, ...failed]);
    }
  }

  /** Messages currently queued on a queue, for assertions in tests. */
  pending(queue: string): WorkflowMessage[] {
    return (this.queues.get(queue) ?? []).map((e) => e.message);
  }

  async close(): Promise<void> {
    this.queues.clear();
    this.handlers.clear();
  }
}
