import {
  PreFlightCheckActionOutcome, StepContext, StepDefinition, WorkflowStatus, isResumeBlocked, resolveStepType,
} from "@wfe/sdk";
import { pick } from "lodash";
import { StepRun } from "../entities/step-run";
import { WorkflowRun } from "../entities/workflow-run";
import { WfeError } from "../errors";
import { captureParameters } from "../expression/capture";
import { WorkflowManager } from "./workflow-manager";

export interface ExecuteStepResult {
  run: WorkflowRun;
  delaySeconds?: number;
}

export class RunExecutor extends WorkflowManager {
  /** Only the allowlisted config keys are ever visible to an expression. */
  protected expressionConfig(): Record<string, unknown> {
    return pick(this.config as unknown as Record<string, unknown>, this.config.expressionConfigKeys ?? []);
  }

  protected async definitionStepsFor(run: WorkflowRun): Promise<StepDefinition[]> {
    const definition = await this.lookupDefinition({
      tenantId: run.tenantId, name: run.name, version: run.version,
      inputs: {}, definitionId: run.definitionId,
    });
    return definition.definition.steps;
  }

  async executeStep(run: WorkflowRun, stepNumber: number, body?: unknown): Promise<ExecuteStepResult> {
    const steps = await this.definitionStepsFor(run);
    const stepDefinition = steps[stepNumber];
    if (!stepDefinition) {
      throw new WfeError(`Run ${run.id} has no step at index ${stepNumber}`, {
        statusCode: 400, code: "STEP_INDEX_OUT_OF_RANGE",
      });
    }

    const stepRun = run.stepRuns![stepNumber] as StepRun;
    const step = this.registry.create(resolveStepType(stepDefinition), {
      name: stepDefinition.stepName,
      version: stepDefinition.stepVersion,
      type: resolveStepType(stepDefinition),
    });

    const config = this.expressionConfig();
    stepRun.lastStepAction = new Date();
    stepRun.status = WorkflowStatus.RUNNING;

    try {
      // 1. Declarative pre-flight check.
      if (stepDefinition.preFlightCheck) {
        const { conditionsToCheck, actionOnFailure, failureMessage } = stepDefinition.preFlightCheck;
        const conditions = await captureParameters({
          evaluator: this.evaluator, run, expressions: conditionsToCheck, config, body,
        });
        const allTrue = Object.values(conditions).every((value) => value === true);

        if (!allTrue) {
          const message = failureMessage ?? `Pre-flight check failed for step ${stepDefinition.stepName}`;
          if (actionOnFailure === PreFlightCheckActionOutcome.FAIL) {
            throw new WfeError(message, { statusCode: 400, code: "PREFLIGHT_FAILED" });
          }
          if (actionOnFailure === PreFlightCheckActionOutcome.SKIP) {
            stepRun.status = WorkflowStatus.SKIPPED;
            stepRun.message = message;
            await this.runs.save(run);
            return { run };
          }
          stepRun.message = message; // CONTINUE
        }
      }

      // 2. Resolve inputs.
      const inputs = await captureParameters({
        evaluator: this.evaluator, run, expressions: stepDefinition.stepInputs, config, body,
      });
      stepRun.inputs = inputs;

      // 3. Run.
      const ctx: StepContext = {
        config, logger: this.log, services: this.services,
        run, step: stepRun, stepNumber, inputs, body,
      };
      await step.onBeforeRun(ctx);
      const response = await step.run(ctx);

      // 4. Capture outputs and state from the post-run run snapshot.
      if (stepDefinition.stepOutputs?.length) {
        const outputs = await captureParameters({
          evaluator: this.evaluator, run, expressions: stepDefinition.stepOutputs, config, body,
        });
        run.outputs = { ...run.outputs, ...outputs };
      }
      if (stepDefinition.stepStateCapture?.length) {
        const state = await captureParameters({
          evaluator: this.evaluator, run, expressions: stepDefinition.stepStateCapture, config, body,
        });
        run.state = { ...run.state, ...state };
      }

      const saved = await this.runs.save(run);
      return { run: saved, delaySeconds: response.delaySeconds };
    } catch (err) {
      stepRun.status = WorkflowStatus.FAILED;
      stepRun.message = (err as Error).message;
      run.status = WorkflowStatus.FAILED;
      await this.runs.save(run);
      this.log.error("Step execution failed", {
        runId: run.id, stepNumber, stepName: stepDefinition.stepName, error: (err as Error).message,
      });
      throw err;
    }
  }

  /** Begins execution of a freshly created run at step 0. */
  async start(tenantId: string, runId: number): Promise<WorkflowRun> {
    return this.run(tenantId, runId, 0);
  }

  /**
   * Advances a run from `stepNumber` until it completes, fails, or suspends.
   *
   * Queue delivery is at-least-once, so this is called with stale messages. The
   * guards below discard those instead of re-running work.
   */
  async run(tenantId: string, runId: number, stepNumber: number, body?: unknown): Promise<WorkflowRun> {
    let run = await this.runs.findById(tenantId, runId);
    if (!run) {
      throw new WfeError(`Cannot locate workflow run ${runId}`, {
        statusCode: 404, code: "RUN_NOT_FOUND",
      });
    }

    if (isResumeBlocked(run.status)) {
      this.log.warn("Discarding resume for a run in a blocked state", {
        runId, stepNumber, status: run.status,
      });
      return run;
    }

    // -1 means "not started"; only stepNumber 0 may start it. Any other
    // mismatch — including a non-zero stepNumber against an unstarted run —
    // is a stale or malformed message.
    const staleStep = run.currentStep === -1 ? stepNumber !== 0 : run.currentStep !== stepNumber;
    if (staleStep) {
      this.log.warn("Discarding resume for a stale step number", {
        runId, stepNumber, currentStep: run.currentStep,
      });
      return run;
    }

    const steps = await this.definitionStepsFor(run);
    let nextStep = stepNumber;
    let payload = body;

    while (nextStep < steps.length) {
      run.currentStep = nextStep;
      run.status = WorkflowStatus.RUNNING;
      run = await this.runs.save(run);

      const result = await this.executeStep(run, nextStep, payload);
      run = result.run;
      payload = undefined; // a callback payload applies only to the step it resumed

      if (result.delaySeconds !== undefined) {
        run.status = WorkflowStatus.WAITING;
        return this.runs.save(run);
      }

      nextStep += 1;
    }

    run.currentStep = steps.length - 1;
    run.status = WorkflowStatus.COMPLETE;
    return this.runs.save(run);
  }

  /** Marks a run cancelled. In-flight steps are not interrupted. */
  async cancel(tenantId: string, runId: number): Promise<WorkflowRun> {
    const run = await this.runs.findById(tenantId, runId);
    if (!run) {
      throw new WfeError(`Cannot locate workflow run ${runId}`, {
        statusCode: 404, code: "RUN_NOT_FOUND",
      });
    }
    run.status = WorkflowStatus.CANCELLED;
    this.log.info("Cancelled workflow run", { runId, tenantId });
    return this.runs.save(run);
  }

  /** Resets the given step and everything after it, then runs from there. */
  async restartFromStep(tenantId: string, runId: number, stepNumber: number): Promise<WorkflowRun> {
    const run = await this.runs.findById(tenantId, runId);
    if (!run) {
      throw new WfeError(`Cannot locate workflow run ${runId}`, {
        statusCode: 404, code: "RUN_NOT_FOUND",
      });
    }

    for (const step of run.stepRuns ?? []) {
      if (step.stepNumber >= stepNumber) {
        step.status = WorkflowStatus.NEW;
        step.message = undefined;
        step.outputs = {};
        step.state = {};
      }
    }
    run.currentStep = stepNumber;
    run.status = WorkflowStatus.RUNNING;
    await this.runs.save(run);

    return this.run(tenantId, runId, stepNumber);
  }
}
