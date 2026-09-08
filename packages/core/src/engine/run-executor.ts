import {
  PreFlightCheckActionOutcome, StepContext, StepDefinition, StepSuspension, WorkflowStatus, isResumeBlocked,
  resolveStepType,
} from "@wfe/sdk";
import { pick } from "lodash";
import { WorkflowRun } from "../entities/workflow-run";
import { WfeError } from "../errors";
import { captureParameters } from "../expression/capture";
import { WorkflowMessage } from "../queue/types";
import { planSuspension } from "./suspension";
import { WorkflowManager } from "./workflow-manager";

export interface ExecuteStepResult {
  run: WorkflowRun;
  suspend?: StepSuspension;
}

/** Step statuses executeStep must not overwrite after step.run() returns. */
const SETTLED_STEP_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  WorkflowStatus.COMPLETE,
  WorkflowStatus.SKIPPED,
  WorkflowStatus.FAILED,
  WorkflowStatus.WAITING,
  WorkflowStatus.CANCELLED,
]);

export class RunExecutor extends WorkflowManager {
  /**
   * Only the allowlisted keys of `expressionValues` are ever visible to an
   * expression. This is sourced from `expressionValues`, never from `this.config`
   * itself — dbUrl and every other engine-internal field live on a sibling
   * property of EngineConfig, so no allowlist entry can ever expose them.
   */
  protected expressionConfig(): Record<string, unknown> {
    return pick(this.config.expressionValues ?? {}, this.config.expressionConfigKeys ?? []);
  }

  protected async definitionStepsFor(run: WorkflowRun): Promise<StepDefinition[]> {
    const definition = await this.lookupDefinition({
      tenantId: run.tenantId, name: run.name, version: run.version,
      inputs: {}, definitionId: run.definitionId,
    });
    return definition.definition.steps;
  }

  /**
   * Saves `run`, unless another writer already committed a halting status
   * while this step was in flight. That write is already the authoritative
   * state: a plain save here would clobber it, and `saveChecked` would
   * spuriously conflict against it (this entity's revision predates that
   * write) — so this reconciles `run.status` in memory and returns without
   * writing again instead. Used by every non-error return out of
   * `executeStep` that would otherwise call `saveChecked` directly.
   */
  protected async saveUnlessResumeBlocked(run: WorkflowRun): Promise<WorkflowRun> {
    const authoritativeStatus = await this.runs.getStatus(run.tenantId, run.id!);
    if (authoritativeStatus && isResumeBlocked(authoritativeStatus)) {
      run.status = authoritativeStatus;
      return run;
    }
    return this.runs.saveChecked(run);
  }

  async executeStep(run: WorkflowRun, stepNumber: number, body?: unknown): Promise<ExecuteStepResult> {
    const steps = await this.definitionStepsFor(run);
    const stepDefinition = steps[stepNumber];
    if (!stepDefinition) {
      throw new WfeError(`Run ${run.id} has no step at index ${stepNumber}`, {
        statusCode: 400, code: "STEP_INDEX_OUT_OF_RANGE",
      });
    }

    const stepRun = run.stepRuns?.[stepNumber];
    if (!stepRun) {
      // A definition that gained a step while a run created from an earlier
      // version of it is in flight leaves this run with no matching step-run
      // row. Full fix (snapshotting the definition onto the run) is deferred;
      // this at least turns the dereference into a typed 400 instead of a
      // raw TypeError.
      throw new WfeError(`Run ${run.id} has no step-run row at index ${stepNumber}`, {
        statusCode: 400, code: "STEP_RUN_MISSING",
      });
    }
    const step = this.registry.create(resolveStepType(stepDefinition), {
      name: stepDefinition.stepName,
      version: stepDefinition.stepVersion,
      type: resolveStepType(stepDefinition),
    });

    // A step that suspended was left WAITING; re-entering it is by
    // definition a resume. Deriving this from the payload instead would be
    // wrong: a delay resume carries no body, so the step would re-enter as a
    // first entry, suspend again, and the run would re-enqueue itself
    // forever. This must be read before the status is overwritten below.
    const isResume = stepRun.status === WorkflowStatus.WAITING;

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
            const saved = await this.saveUnlessResumeBlocked(run);
            return { run: saved };
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
        run, step: stepRun, stepNumber, inputs, body, isResume,
      };
      if (!isResume) {
        await step.start(ctx);
      }
      const response = await step.run(ctx);

      // Nothing else enforces that a step reaches a terminal status: a
      // third-party step that returns without touching ctx.step.status would
      // otherwise leave this row RUNNING forever while the run moves on.
      // Only settle it here when the step didn't already choose SKIPPED,
      // FAILED, WAITING or CANCELLED (or already COMPLETE) for itself, and
      // isn't suspending.
      if (!response.suspend && !SETTLED_STEP_STATUSES.has(stepRun.status)) {
        stepRun.status = WorkflowStatus.COMPLETE;
      }

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

      // The step may have cancelled its own run out of band (e.g. via
      // executor.cancel()) while it was executing. `run` is a stale in-memory
      // entity — it still holds whatever status the advance loop set before
      // calling us — so a blind save here would clobber that cancellation
      // back to RUNNING. saveUnlessResumeBlocked re-reads the authoritative
      // status first and, if it has moved to a resume-blocked state,
      // reconciles instead of writing.
      const saved = await this.saveUnlessResumeBlocked(run);
      return { run: saved, suspend: response.suspend };
    } catch (err) {
      // Two families of error reach here besides a genuine step failure:
      // saveUnlessResumeBlocked's saveChecked (from either call site above)
      // can itself throw RUN_CONFLICT (another writer won the race) or
      // RUN_LOCK_TIMEOUT (the row was contended too long) — both meant to be
      // retried by the caller, not buried under a fabricated FAILED. And even
      // for an unrelated step error, another writer may have already
      // committed a halting status (e.g. a concurrent cancel()) while the
      // step was running; a plain save() below would otherwise clobber that
      // already-persisted state, defeating the operator's cancel and — since
      // restartFromStep only refuses CANCELLED — making the clobbered run
      // look restartable. Check both before writing.
      const isSaveConflict = err instanceof WfeError
        && (err.code === "RUN_CONFLICT" || err.code === "RUN_LOCK_TIMEOUT");
      const authoritativeStatus = await this.runs.getStatus(run.tenantId, run.id!);
      if (isSaveConflict || (authoritativeStatus && isResumeBlocked(authoritativeStatus))) {
        this.log.warn("Not persisting FAILED: the run was concurrently modified or a checked save could not complete", {
          runId: run.id, stepNumber, status: authoritativeStatus, error: (err as Error).message,
        });
        throw err;
      }

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
      // Re-read the authoritative status before starting the next step: a
      // concurrent cancel() writes CANCELLED via its own fresh entity, and
      // the in-memory `run` here would otherwise blindly overwrite that back
      // to RUNNING on the next save (TypeORM's save() is a full-row UPDATE).
      const currentStatus = await this.runs.getStatus(tenantId, runId);
      if (currentStatus && isResumeBlocked(currentStatus)) {
        this.log.warn("Stopping run advance: run moved to a resume-blocked state out of band", {
          runId, stepNumber: nextStep, status: currentStatus,
        });
        run.status = currentStatus;
        return run;
      }

      run.currentStep = nextStep;
      run.status = WorkflowStatus.RUNNING;
      run = await this.runs.saveChecked(run);

      const result = await this.executeStep(run, nextStep, payload);
      run = result.run;
      payload = undefined; // a callback payload applies only to the step it resumed

      if (result.suspend) {
        // executeStep's own saveUnlessResumeBlocked may already have
        // reconciled run.status to a halting status another writer
        // committed while the step was suspending (e.g. a concurrent
        // cancel()) — that write is already persisted. Resurrecting WAITING
        // over it here would both defeat the cancel and hit saveChecked with
        // this entity's now-stale revision, producing a spurious RUN_CONFLICT
        // for a synchronous caller instead of just returning the cancelled run.
        if (isResumeBlocked(run.status)) {
          this.log.warn("Not suspending: run moved to a resume-blocked state out of band", {
            runId, stepNumber: nextStep, status: run.status,
          });
          return run;
        }
        run.status = WorkflowStatus.WAITING;
        const saved = await this.runs.saveChecked(run);
        await this.publishSuspension(saved, nextStep, result.suspend, 0);
        return saved;
      }

      nextStep += 1;
    }

    run.currentStep = steps.length - 1;
    run.status = WorkflowStatus.COMPLETE;
    return this.runs.saveChecked(run);
  }

  /**
   * Publishes the message that will resume this step. Core owns this rather
   * than the caller so a delay longer than the driver's limit can be chained
   * transparently — spec §8.
   */
  protected async publishSuspension(
    run: WorkflowRun, stepNumber: number, suspend: StepSuspension, carried: number
  ): Promise<void> {
    if (!this.queue) {
      throw new WfeError(
        `Step ${stepNumber} of run ${run.id} suspended, but no queue driver is configured to resume it`,
        { statusCode: 500, code: "QUEUE_NOT_CONFIGURED" }
      );
    }

    const effective: StepSuspension =
      carried > 0 ? { kind: "delay", delaySeconds: carried } : suspend;
    const plan = planSuspension(effective, this.queue.maxDelaySeconds);

    await this.queue.publish(
      plan.queue,
      {
        tenantId: run.tenantId,
        runId: run.id!,
        stepNumber,
        kind: "resume",
        correlationId: effective.kind === "awaitCallback" ? effective.correlationId : undefined,
        remainingDelaySeconds: plan.remaining,
      },
      { delaySeconds: plan.delaySeconds }
    );
  }

  /**
   * Entry point for a queue consumer. Chains the next hop when the message
   * still carries unspent delay, otherwise re-enters the advance loop — where
   * the Phase 1 guards discard duplicates and stale deliveries.
   */
  async resume(msg: WorkflowMessage): Promise<WorkflowRun> {
    if (msg.remainingDelaySeconds && msg.remainingDelaySeconds > 0) {
      const run = await this.runs.findById(msg.tenantId, msg.runId);
      if (!run) {
        throw new WfeError(`Cannot locate workflow run ${msg.runId}`, {
          statusCode: 404, code: "RUN_NOT_FOUND",
        });
      }
      if (isResumeBlocked(run.status)) {
        this.log.warn("Discarding chained delay for a run in a blocked state", {
          runId: msg.runId, status: run.status,
        });
        return run;
      }
      await this.publishSuspension(
        run, msg.stepNumber, { kind: "delay", delaySeconds: msg.remainingDelaySeconds }, msg.remainingDelaySeconds
      );
      return run;
    }

    return this.run(msg.tenantId, msg.runId, msg.stepNumber, msg.body);
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

    // A cancelled run must stay cancelled: without this, a restart silently
    // overwrites CANCELLED with RUNNING below, defeating an operator's cancel.
    if (run.status === WorkflowStatus.CANCELLED) {
      throw new WfeError(`Run ${runId} is cancelled and cannot be restarted`, {
        statusCode: 400, code: "RUN_CANCELLED",
      });
    }

    const steps = await this.definitionStepsFor(run);
    if (!Number.isInteger(stepNumber) || stepNumber < 0 || stepNumber >= steps.length) {
      // Reachable directly from a user-supplied path parameter (PUT
      // /runs/:id/restart/step/:n). Without this bound check, an out-of-range
      // stepNumber falls through every guard in run() below and the run is
      // marked COMPLETE having executed zero steps (or, for a negative
      // number, stays stranded in RUNNING forever).
      throw new WfeError(
        `Run ${runId} has no step at index ${stepNumber} (definition has ${steps.length} step(s))`,
        { statusCode: 400, code: "RESTART_STEP_OUT_OF_RANGE" }
      );
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
