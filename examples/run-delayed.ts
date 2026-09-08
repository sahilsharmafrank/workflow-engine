import "reflect-metadata";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DbContext, DefinitionRepository, DELAY_QUEUE, ExpressionEvaluator, MemoryQueueDriver,
  RunExecutor, RunRepository, StepRegistry, WorkflowWorker,
  loadEngineConfig, registerBuiltInSteps, validateDefinitionShape,
} from "@wfe/core";
import { WorkflowDefinitionStatus } from "@wfe/sdk";

async function main(): Promise<void> {
  const config = loadEngineConfig();
  const db = new DbContext(config);
  await db.runMigrations();

  const registry = new StepRegistry();
  registerBuiltInSteps(registry);

  // The memory driver keeps state in-process, so this single script can play
  // both the executor that enqueues the resume and the worker that consumes
  // it. A RabbitMQ or SQS deployment would run the worker as a separate
  // process against the same queues instead.
  const queue = new MemoryQueueDriver();
  await queue.ensureQueues([{ queueName: DELAY_QUEUE }]);

  const evaluator = new ExpressionEvaluator({ timeoutMs: config.expressionTimeoutMs });
  const executor = new RunExecutor({ config, db, registry, evaluator, queue });

  const raw = JSON.parse(readFileSync(join(__dirname, "definitions/delayed.json"), "utf8"));
  const definition = await validateDefinitionShape(raw.definition);
  await new DefinitionRepository(db).create({
    tenantId: "default", name: raw.workflowName, version: raw.workflowVersion,
    definition, status: WorkflowDefinitionStatus.PUBLISHED,
  });

  const worker = new WorkflowWorker({ executor, queue });
  await worker.start();

  const runId = await executor.startWorkflow({
    tenantId: "default", name: raw.workflowName, version: raw.workflowVersion,
    inputs: { jobId: "job-99" },
  });
  const parked = await executor.start("default", runId);
  console.log(`After start: run ${runId} is "${parked.status}"`);

  // The Wait step asked for 45 seconds. MemoryQueueDriver's clock is virtual
  // rather than wall-clock, so the resume is made visible by advancing it and
  // draining, instead of actually sleeping for 45 real seconds. A RabbitMQ or
  // SQS worker's own subscription loop does this delivery on its own.
  queue.advanceTime(45_000);
  await queue.drain();

  const finished = await new RunRepository(db).findById("default", runId);
  console.log(JSON.stringify({
    runId, status: finished?.status, outputs: finished?.outputs,
  }, null, 2));

  await worker.stop();
  await queue.close();
  evaluator.dispose();
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
