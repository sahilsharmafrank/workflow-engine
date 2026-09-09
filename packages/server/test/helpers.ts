import "reflect-metadata";
import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  DbContext, ExpressionEvaluator, MemoryQueueDriver, RunExecutor,
  StepRegistry, registerBuiltInSteps, DELAY_QUEUE, RESPONSE_QUEUE,
} from "@wfe/core";
import { Express } from "express";
import { createApp } from "../src/app";
import { NoneAuthProvider } from "../src/auth/none-provider";

export interface TestContext {
  app: Express;
  db: DbContext;
  executor: RunExecutor;
  queue: MemoryQueueDriver;
  registry: StepRegistry;
  evaluator: ExpressionEvaluator;
  cleanup: () => Promise<void>;
}

export async function createTestApp(container: StartedPostgreSqlContainer): Promise<TestContext> {
  const config = { dbUrl: container.getConnectionUri() };
  const db = new DbContext(config);
  await db.runMigrations();

  const registry = new StepRegistry();
  registerBuiltInSteps(registry);

  const queue = new MemoryQueueDriver();
  await queue.ensureQueues([{ queueName: DELAY_QUEUE }, { queueName: RESPONSE_QUEUE }]);

  const evaluator = new ExpressionEvaluator({ timeoutMs: 200 });
  const executor = new RunExecutor({ config, db, registry, evaluator, queue });

  const app = createApp({
    executor,
    db,
    registry,
    authProvider: new NoneAuthProvider(),
    evaluator,
    queue,
  });

  return {
    app, db, executor, queue, registry, evaluator,
    cleanup: async () => {
      evaluator.dispose();
      await queue.close();
      await db.close();
    },
  };
}
