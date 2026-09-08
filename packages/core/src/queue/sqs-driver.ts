import {
  CreateQueueCommand, DeleteMessageCommand, GetQueueUrlCommand,
  ReceiveMessageCommand, SendMessageCommand, SQSClient, SQSClientConfig,
} from "@aws-sdk/client-sqs";
import { registerQueueDriver } from "./registry";
import { QueueDefinition, QueueDriver, QueueDriverOptions, Unsubscribe, WorkflowMessage } from "./types";

/** Pause between receive retries after a non-abort failure, so a persistently
 * failing endpoint (throttling, network blip, bad credentials, ...) cannot
 * hot-spin the loop. */
const RECEIVE_RETRY_DELAY_MS = 1000;

/** Resolves after `ms`, or immediately if `signal` aborts first — so a pause
 * never outlives an in-flight `unsubscribe`/`close`. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class SqsQueueDriver implements QueueDriver {
  readonly name = "sqs";
  /** SQS caps native per-message delay at 900s; core chains anything longer. */
  readonly maxDelaySeconds = 900;

  private readonly client: SQSClient;
  private readonly prefix: string;
  private readonly urls = new Map<string, string>();
  private readonly abortControllers = new Set<AbortController>();
  private readonly loopPromises = new Set<Promise<void>>();
  private stopped = false;

  constructor(options: QueueDriverOptions) {
    this.prefix = (options.prefix as string) ?? "wfe";
    this.client = new SQSClient({
      region: (options.region as string) ?? process.env.AWS_REGION,
      ...(options.endpoint ? { endpoint: options.endpoint as string } : {}),
      ...(options.credentials
        ? { credentials: options.credentials as SQSClientConfig["credentials"] }
        : {}),
    });
  }

  private physicalName(queue: string): string {
    return `${this.prefix}-${queue}`;
  }

  async ensureQueues(defs: QueueDefinition[]): Promise<void> {
    for (const def of defs) {
      const name = this.physicalName(def.queueName);
      const created = await this.client.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: {
            MessageRetentionPeriod: "86400",
            // Short enough that a failed handler's message returns promptly.
            VisibilityTimeout: "10",
          },
        })
      );
      if (created.QueueUrl) {
        this.urls.set(def.queueName, created.QueueUrl);
      }
    }
  }

  private async urlFor(queue: string): Promise<string> {
    const cached = this.urls.get(queue);
    if (cached) return cached;
    const found = await this.client.send(
      new GetQueueUrlCommand({ QueueName: this.physicalName(queue) })
    );
    const url = found.QueueUrl!;
    this.urls.set(queue, url);
    return url;
  }

  async publish(queue: string, msg: WorkflowMessage, opts?: { delaySeconds?: number }): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.urlFor(queue),
        MessageBody: JSON.stringify(msg),
        DelaySeconds: Math.min(opts?.delaySeconds ?? 0, this.maxDelaySeconds),
      })
    );
  }

  async subscribe(queue: string, handler: (msg: WorkflowMessage) => Promise<void>): Promise<Unsubscribe> {
    const url = await this.urlFor(queue);
    let running = true;
    const abortController = new AbortController();
    this.abortControllers.add(abortController);

    const loop = async (): Promise<void> => {
      while (running && !this.stopped) {
        let received;
        try {
          received = await this.client.send(
            new ReceiveMessageCommand({
              QueueUrl: url, MaxNumberOfMessages: 1, WaitTimeSeconds: 5,
            }),
            { abortSignal: abortController.signal }
          );
        } catch (err) {
          if (abortController.signal.aborted) {
            // Aborted by unsubscribe/close while long-polling: exit quietly
            // rather than let a stale loop keep competing for messages.
            return;
          }
          // A real failure (throttling, network blip, bad credentials, ...):
          // the subscription must not die silently. Log and keep polling
          // after a fixed pause, rather than hot-spinning the endpoint.
          console.error(`sqs-driver: receive failed for queue "${queue}"`, err);
          await abortableDelay(RECEIVE_RETRY_DELAY_MS, abortController.signal);
          continue;
        }
        for (const message of received.Messages ?? []) {
          if (!message.Body) continue;
          try {
            await handler(JSON.parse(message.Body) as WorkflowMessage);
            // Delete only on success: an un-deleted message becomes visible
            // again after the visibility timeout — at-least-once by design.
            await this.client.send(
              new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle })
            );
          } catch {
            // Leave it for redelivery.
          }
        }
      }
    };

    // Awaiting the loop's promise (rather than just flipping `running`)
    // guarantees the loop has actually exited before the caller subscribes
    // again on the same queue — otherwise a still-in-flight receive can
    // steal and delete a message meant for the next subscriber. Tracked in
    // `loopPromises` too, so `close()` can offer the same guarantee for
    // callers that skip individual `unsubscribe()` calls.
    const loopPromise = loop().finally(() => {
      this.abortControllers.delete(abortController);
      this.loopPromises.delete(loopPromise);
    });
    this.loopPromises.add(loopPromise);

    return async () => {
      running = false;
      abortController.abort();
      await loopPromise;
    };
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    await Promise.all(this.loopPromises);
    this.client.destroy();
  }
}

registerQueueDriver("sqs", (options) => new SqsQueueDriver(options));
