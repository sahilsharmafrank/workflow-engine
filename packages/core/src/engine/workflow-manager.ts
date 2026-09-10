import {
  Logger, WorkflowParameters, WorkflowStatus, resolveStepType,
} from "@wfe/sdk";
import { EngineConfig } from "../config";
import { DbContext } from "../db/db-context";
import { StepRun } from "../entities/step-run";
import { WorkflowDefinitionEntity } from "../entities/workflow-definition";
import { WorkflowRun } from "../entities/workflow-run";
import { WfeError } from "../errors";
import { ExpressionEvaluator } from "../expression/evaluator";
import { createLogger } from "../logging";
import { QueueDriver } from "../queue/types";
import { StepRegistry } from "../registry/step-registry";
import { validateAgainstRegistry } from "../registry/validate";
import { DefinitionRepository } from "../repositories/definition-repository";
import { RunRepository } from "../repositories/run-repository";

export interface EngineDeps {
  config: EngineConfig;
  db: DbContext;
  registry: StepRegistry;
  evaluator: ExpressionEvaluator;
  services?: Record<string, unknown>;
  logger?: Logger;
  queue?: QueueDriver;
}

export interface StartWorkflowInput {
  tenantId: string;
  name: string;
  version: string;
  inputs: WorkflowParameters;
  definitionId?: number;
  /** Set internally when this run is a child started by core.subWorkflow. */
  parentRunId?: number;
  /** Nesting depth in the parent chain. Omitted (or 0) for a normal start. */
  depth?: number;
}

export class WorkflowManager {
  protected readonly config: EngineConfig;
  protected readonly db: DbContext;
  protected readonly registry: StepRegistry;
  protected readonly evaluator: ExpressionEvaluator;
  protected readonly services: Record<string, unknown>;
  protected readonly log: Logger;
  protected readonly definitions: DefinitionRepository;
  protected readonly runs: RunRepository;
  protected readonly queue?: QueueDriver;

  constructor(deps: EngineDeps) {
    this.config = deps.config;
    this.db = deps.db;
    this.registry = deps.registry;
    this.evaluator = deps.evaluator;
    this.services = deps.services ?? {};
    this.log = deps.logger ?? createLogger("workflow-manager");
    this.definitions = new DefinitionRepository(deps.db);
    this.runs = new RunRepository(deps.db);
    this.queue = deps.queue;
  }

  protected async lookupDefinition(input: StartWorkflowInput): Promise<WorkflowDefinitionEntity> {
    const found = input.definitionId
      ? await this.definitions.findById(input.tenantId, input.definitionId)
      : await this.definitions.findPublished(input.tenantId, input.name, input.version);

    if (!found) {
      throw new WfeError(
        `No published workflow definition found for name="${input.name}" version="${input.version}"`,
        { statusCode: 404, code: "DEFINITION_NOT_FOUND" }
      );
    }
    return found;
  }

  /**
   * Materializes a run and one step row per definition step. Nothing executes
   * here — the run is left at currentStep -1 for the executor to pick up.
   */
  async startWorkflow(input: StartWorkflowInput): Promise<number> {
    const depth = input.depth ?? 0;
    const maxDepth = this.config.maxSubWorkflowDepth ?? 10;
    // Checked before touching the definition or creating any row: a
    // self-starting (or mutually-recursive) definition must be stopped
    // before it produces another run, not merely fail after leaving one
    // behind — otherwise this guard degrades into a slower way to run away.
    if (depth > maxDepth) {
      throw new WfeError(
        `Sub-workflow depth ${depth} exceeds the configured maximum of ${maxDepth} (WFE_MAX_SUBWORKFLOW_DEPTH)`,
        { statusCode: 400, code: "SUB_WORKFLOW_DEPTH_EXCEEDED" }
      );
    }

    const definition = await this.lookupDefinition(input);
    validateAgainstRegistry(definition.definition, this.registry);

    const run = new WorkflowRun();
    run.tenantId = input.tenantId;
    run.definitionId = definition.id;
    run.name = input.name;
    run.version = input.version;
    run.parentRunId = input.parentRunId;
    run.depth = depth;
    run.currentStep = -1;
    run.status = WorkflowStatus.STARTING;
    run.definitionSnapshot = definition.definition;
    run.inputs = input.inputs;
    run.outputs = {};
    run.state = {};
    run.stepRuns = definition.definition.steps.map((stepDefinition, index) => {
      const step = new StepRun();
      step.tenantId = input.tenantId;
      step.stepNumber = index;
      step.stepName = stepDefinition.stepName;
      step.stepType = resolveStepType(stepDefinition);
      step.status = WorkflowStatus.NEW;
      step.externalServiceName = stepDefinition.externalServiceName;
      step.inputs = {};
      step.outputs = {};
      step.state = {};
      step.lastStepAction = new Date();
      return step;
    });

    const saved = await this.runs.save(run);
    this.log.info("Created workflow run", {
      runId: saved.id, name: input.name, version: input.version, tenantId: input.tenantId,
    });
    return saved.id!;
  }
}
