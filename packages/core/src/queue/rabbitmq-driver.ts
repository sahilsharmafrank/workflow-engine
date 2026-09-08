import * as amqp from "amqplib";
import { registerQueueDriver } from "./registry";
import { QueueDefinition, QueueDriver, QueueDriverOptions, Unsubscribe, WorkflowMessage } from "./types";

const DELAY_EXCHANGE = "wfe-delay-exchange";
/** TTL buckets in seconds. A message only ever queues behind equal-TTL peers. */
const DELAY_BUCKETS = [10, 60, 300, 900];

export class RabbitMqQueueDriver implements QueueDriver {
  readonly name = "rabbitmq";
  readonly maxDelaySeconds = 900;

  private readonly url: string;
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;

  constructor(options: QueueDriverOptions) {
    if (!options.url) {
      throw new Error("rabbitmq queue driver requires a url");
    }
    this.url = options.url;
  }

  private async getChannel(): Promise<amqp.Channel> {
    if (!this.channel) {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(DELAY_EXCHANGE, "direct", { durable: true });
    }
    return this.channel;
  }

  async ensureQueues(defs: QueueDefinition[]): Promise<void> {
    const channel = await this.getChannel();
    for (const def of defs) {
      await channel.assertQueue(def.queueName, { durable: true });
      await channel.bindQueue(def.queueName, DELAY_EXCHANGE, def.queueName);

      // One holding queue per bucket per target: messages dead-letter back to
      // the work queue when their TTL expires.
      for (const bucket of DELAY_BUCKETS) {
        await channel.assertQueue(this.holdingQueue(def.queueName, bucket), {
          durable: true,
          messageTtl: bucket * 1000,
          deadLetterExchange: DELAY_EXCHANGE,
          deadLetterRoutingKey: def.queueName,
        });
      }
    }
  }

  private holdingQueue(queue: string, bucketSeconds: number): string {
    return `${queue}-delay-${bucketSeconds}`;
  }

  private bucketFor(delaySeconds: number): number {
    return DELAY_BUCKETS.find((b) => b >= delaySeconds) ?? DELAY_BUCKETS[DELAY_BUCKETS.length - 1];
  }

  async publish(queue: string, msg: WorkflowMessage, opts?: { delaySeconds?: number }): Promise<void> {
    const channel = await this.getChannel();
    const payload = Buffer.from(JSON.stringify(msg));
    const delay = opts?.delaySeconds ?? 0;

    if (delay <= 0) {
      channel.sendToQueue(queue, payload, { persistent: true });
      return;
    }

    channel.sendToQueue(this.holdingQueue(queue, this.bucketFor(delay)), payload, { persistent: true });
  }

  async subscribe(queue: string, handler: (msg: WorkflowMessage) => Promise<void>): Promise<Unsubscribe> {
    const channel = await this.getChannel();
    await channel.prefetch(1);

    const { consumerTag } = await channel.consume(queue, (raw) => {
      if (!raw) return;
      void (async () => {
        try {
          await handler(JSON.parse(raw.content.toString()) as WorkflowMessage);
          channel.ack(raw);
        } catch {
          // At-least-once: requeue so the message is redelivered rather than lost.
          channel.nack(raw, false, true);
        }
      })();
    });

    return async () => {
      await channel.cancel(consumerTag);
    };
  }

  async close(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
    this.channel = undefined;
    this.connection = undefined;
  }
}

registerQueueDriver("rabbitmq", (options) => new RabbitMqQueueDriver(options));
