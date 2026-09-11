#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import {
  DbContext, ExpressionEvaluator, StepRegistry, registerBuiltInSteps,
  createQueueDriver, RunExecutor, WorkflowWorker,
  DefinitionRepository, validateDefinitionShape, validateAgainstRegistry,
  createLogger, DELAY_QUEUE, RESPONSE_QUEUE, loadPlugins,
} from "@wfe/core";
import { loadServerConfig } from "../config";
import { createApp } from "../app";
import { NoneAuthProvider } from "../auth/none-provider";

const log = createLogger("cli");
const program = new Command();

program
  .name("wfe")
  .description("Workflow Engine CLI")
  .version("0.1.0");

program
  .command("migrate")
  .description("Run database migrations")
  .action(async () => {
    const config = loadServerConfig();
    const db = new DbContext(config);
    try {
      await db.runMigrations();
      log.info("Migrations complete");
    } finally {
      await db.close();
    }
  });

program
  .command("import <dir>")
  .description("Import workflow definitions from a directory of JSON files")
  .action(async (dir: string) => {
    const config = loadServerConfig();
    const db = new DbContext(config);
    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    await loadPlugins(config.plugins, registry, log);

    try {
      await db.runMigrations();
      const definitions = new DefinitionRepository(db);
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

      for (const file of files) {
        const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
        const body = await validateDefinitionShape(raw.definition);
        validateAgainstRegistry(body, registry);
        await definitions.create({
          tenantId: "default",
          name: raw.workflowName ?? raw.name,
          version: raw.workflowVersion ?? raw.version,
          definition: body,
          status: raw.status,
        });
        log.info("Imported definition", { file, name: raw.workflowName ?? raw.name });
      }
      log.info("Import complete", { count: files.length });
    } finally {
      await db.close();
    }
  });

program
  .command("serve")
  .description("Start the HTTP server")
  .action(async () => {
    const config = loadServerConfig();
    const db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    await loadPlugins(config.plugins, registry, log);
    const evaluator = new ExpressionEvaluator({ timeoutMs: config.expressionTimeoutMs });

    let queue;
    if (config.queueDriver !== "none") {
      // Import driver modules to trigger their self-registration
      if (config.queueDriver === "rabbitmq") await import("@wfe/core/dist/queue/rabbitmq-driver");
      if (config.queueDriver === "sqs") await import("@wfe/core/dist/queue/sqs-driver");
      queue = createQueueDriver(config.queueDriver, {
        url: config.queueUrl,
        prefix: config.sqsPrefix,
        region: config.awsRegion,
      });
      await queue.ensureQueues([{ queueName: DELAY_QUEUE }, { queueName: RESPONSE_QUEUE }]);
    }

    const executor = new RunExecutor({ config, db, registry, evaluator, queue });
    const authProvider = new NoneAuthProvider();

    // Serve the bundled UI when it has been built. Resolved from this package so
    // it works both from source and from the Docker image layout.
    const uiRoot = resolve(__dirname, "../../../ui/dist");
    const uiExists = existsSync(join(uiRoot, "index.html"));
    if (!uiExists) {
      log.warn("No built UI found; serving the API only", { uiRoot });
    }

    const app = createApp({
      executor, db, registry, authProvider, queue, evaluator, config,
      uiRoot: uiExists ? uiRoot : undefined,
    });

    app.listen(config.port, () => {
      log.info("Server started", { port: config.port, queue: config.queueDriver });
    });
  });

program
  .command("worker")
  .description("Start the queue worker (listeners only, no HTTP)")
  .action(async () => {
    const config = loadServerConfig();
    const db = new DbContext(config);
    await db.runMigrations();

    const registry = new StepRegistry();
    registerBuiltInSteps(registry);
    await loadPlugins(config.plugins, registry, log);
    const evaluator = new ExpressionEvaluator({ timeoutMs: config.expressionTimeoutMs });

    // Import driver module
    if (config.queueDriver === "rabbitmq") await import("@wfe/core/dist/queue/rabbitmq-driver");
    if (config.queueDriver === "sqs") await import("@wfe/core/dist/queue/sqs-driver");
    const queue = createQueueDriver(config.queueDriver, {
      url: config.queueUrl,
      prefix: config.sqsPrefix,
      region: config.awsRegion,
    });

    const executor = new RunExecutor({ config, db, registry, evaluator, queue });
    const worker = new WorkflowWorker({ executor, queue });

    await worker.start();
    log.info("Worker started", { driver: config.queueDriver });

    // Graceful shutdown
    const shutdown = async () => {
      log.info("Shutting down worker");
      await worker.stop();
      evaluator.dispose();
      await db.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
