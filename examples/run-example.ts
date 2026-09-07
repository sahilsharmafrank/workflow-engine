import "reflect-metadata";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DbContext, DefinitionRepository, ExpressionEvaluator, RunExecutor,
  StepRegistry, loadEngineConfig, registerBuiltInSteps, validateDefinitionShape,
} from "@wfe/core";
import { WorkflowDefinitionStatus } from "@wfe/sdk";

async function main(): Promise<void> {
  const config = loadEngineConfig();
  const db = new DbContext(config);
  await db.runMigrations();

  const registry = new StepRegistry();
  registerBuiltInSteps(registry);
  const evaluator = new ExpressionEvaluator({ timeoutMs: config.expressionTimeoutMs });
  const executor = new RunExecutor({ config, db, registry, evaluator });

  const raw = JSON.parse(readFileSync(join(__dirname, "definitions/three-step.json"), "utf8"));
  const definition = await validateDefinitionShape(raw.definition);
  await new DefinitionRepository(db).create({
    tenantId: "default", name: raw.workflowName, version: raw.workflowVersion,
    definition, status: WorkflowDefinitionStatus.PUBLISHED,
  });

  const runId = await executor.startWorkflow({
    tenantId: "default", name: raw.workflowName, version: raw.workflowVersion,
    inputs: { jobId: "job-42" },
  });
  const run = await executor.start("default", runId);

  console.log(JSON.stringify({
    runId: run.id, status: run.status, outputs: run.outputs, state: run.state,
    steps: run.stepRuns?.map((s) => ({ n: s.stepNumber, name: s.stepName, status: s.status })),
  }, null, 2));

  evaluator.dispose();
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
