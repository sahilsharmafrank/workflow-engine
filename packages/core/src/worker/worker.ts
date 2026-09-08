import { Logger } from "@wfe/sdk";
import { RunExecutor } from "../engine/run-executor";
import { WfeError } from "../errors";
import { createLogger } from "../logging";
import { DELAY_QUEUE, RESPONSE_QUEUE } from "../queue/names";
import { QueueDriver, Unsubscribe, WorkflowMessage } from "../queue/types";

export interface WorkflowWorkerDeps {
  executor: RunExecutor;
  queue: QueueDriver;
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
  private readonly log: Logger;
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(deps: WorkflowWorkerDeps) {
    this.executor = deps.executor;
    this.queue = deps.queue;
    this.log = deps.logger ?? createLogger("workflow-worker");
  }

  async start(): Promise<void> {
    // Deliberately just these two: a per-service queue (wfe-service-<name>)
    // only ever carries the engine's OUTBOUND dispatch to an external
    // consumer. If this worker also subscribed there, it would compete with
    // that consumer for its own dispatch message and "resume" the step with
    // no body before any real reply arrived — see the final-review C1
    // finding. The only inbound channel back to the engine is RESPONSE_QUEUE
    // (or a direct executor.callback(...) call from outside the worker).
    const queues = [DELAY_QUEUE, RESPONSE_QUEUE];
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
