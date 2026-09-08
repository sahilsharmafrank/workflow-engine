import { Logger } from "@wfe/sdk";
import { RunExecutor } from "../engine/run-executor";
import { WfeError } from "../errors";
import { createLogger } from "../logging";
import { DELAY_QUEUE, RESPONSE_QUEUE, serviceQueueName } from "../queue/names";
import { QueueDriver, Unsubscribe, WorkflowMessage } from "../queue/types";

export interface WorkflowWorkerDeps {
  executor: RunExecutor;
  queue: QueueDriver;
  /** External service names whose request queues this worker should also drain. */
  services?: string[];
  logger?: Logger;
}

/**
 * Errors that will never succeed on redelivery: another consumer already won
 * the run, or the run is gone. Retrying these forever would be a hot loop.
 */
const TERMINAL_CODES = new Set(["RUN_CONFLICT", "RUN_NOT_FOUND", "CALLBACK_STEP_MISMATCH"]);

export class WorkflowWorker {
  private readonly executor: RunExecutor;
  private readonly queue: QueueDriver;
  private readonly services: string[];
  private readonly log: Logger;
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(deps: WorkflowWorkerDeps) {
    this.executor = deps.executor;
    this.queue = deps.queue;
    this.services = deps.services ?? [];
    this.log = deps.logger ?? createLogger("workflow-worker");
  }

  async start(): Promise<void> {
    const queues = [DELAY_QUEUE, RESPONSE_QUEUE, ...this.services.map(serviceQueueName)];
    await this.queue.ensureQueues(queues.map((queueName) => ({ queueName })));

    for (const queueName of queues) {
      const stop = await this.queue.subscribe(queueName, (msg) => this.handle(msg));
      this.subscriptions.push(stop);
    }
    this.log.info("Worker started", { queues });
  }

  private async handle(msg: WorkflowMessage): Promise<void> {
    try {
      if (msg.kind === "callback") {
        await this.executor.callback(msg.tenantId, msg.runId, msg.stepNumber, msg.body);
      } else {
        await this.executor.resume(msg);
      }
    } catch (err) {
      const code = err instanceof WfeError ? err.code : undefined;
      if (code && TERMINAL_CODES.has(code)) {
        // Consume it: redelivery cannot help, and requeueing would spin.
        this.log.warn("Discarding message that cannot succeed on retry", {
          runId: msg.runId, stepNumber: msg.stepNumber, code,
        });
        return;
      }
      this.log.error("Message handling failed; leaving it for redelivery", {
        runId: msg.runId, stepNumber: msg.stepNumber, error: (err as Error).message,
      });
      throw err;
    }
  }

  async stop(): Promise<void> {
    for (const stop of this.subscriptions) {
      await stop();
    }
    this.subscriptions.length = 0;
    this.log.info("Worker stopped");
  }
}
