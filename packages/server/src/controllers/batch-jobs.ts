import { Router } from "express";
import {
  RunExecutor, DbContext, BatchJobRepository,
} from "@wfe/core";
import { AuthenticatedRequest } from "../auth/types";

export function batchJobRoutes(deps: { executor: RunExecutor; db: DbContext }): Router {
  const router = Router();
  const batchJobs = new BatchJobRepository(deps.db);

  router.post("/batch-jobs", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { name, definitionName, definitionVersion, inputs } = req.body;

      if (!Array.isArray(inputs) || inputs.length === 0) {
        res.status(400).json({ error: { code: "BATCH_INVALID_INPUTS", message: "inputs must be a non-empty array" } });
        return;
      }

      const job = await batchJobs.create({
        tenantId,
        name,
        definitionName,
        definitionVersion,
        status: "running",
        totalCount: inputs.length,
        inputs,
        runIds: [],
      });

      const runIds: number[] = [];
      try {
        for (const input of inputs) {
          const runId = await deps.executor.startWorkflow({
            tenantId,
            name: definitionName,
            version: definitionVersion,
            inputs: input ?? {},
          });
          await deps.executor.start(tenantId, runId);
          runIds.push(runId);
        }
        await batchJobs.update(tenantId, job.id!, { runIds, status: "running" });
      } catch (err) {
        await batchJobs.update(tenantId, job.id!, {
          runIds,
          status: "failed",
          message: (err as Error).message,
        });
      }

      const result = await batchJobs.findById(tenantId, job.id!);
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  router.get("/batch-jobs", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { status, limit, offset } = req.query;
      const jobs = await batchJobs.list(tenantId, {
        status: status as string | undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json(jobs);
    } catch (err) { next(err); }
  });

  router.get("/batch-jobs/:id", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const job = await batchJobs.findById(tenantId, Number(req.params.id));
      if (!job) {
        res.status(404).json({ error: { code: "BATCH_JOB_NOT_FOUND", message: `Batch job ${req.params.id} not found` } });
        return;
      }
      const progress = await batchJobs.computeProgress(tenantId, job.id!);
      res.json({ ...job, progress });
    } catch (err) { next(err); }
  });

  router.put("/batch-jobs/:id/cancel", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const job = await batchJobs.findById(tenantId, Number(req.params.id));
      if (!job) {
        res.status(404).json({ error: { code: "BATCH_JOB_NOT_FOUND", message: `Batch job ${req.params.id} not found` } });
        return;
      }

      if (job.status === "complete" || job.status === "failed" || job.status === "cancelled") {
        res.status(409).json({
          error: {
            code: "BATCH_JOB_NOT_CANCELLABLE",
            message: `Batch job ${job.id} is already ${job.status} and cannot be cancelled`,
          },
        });
        return;
      }

      // Cancel all non-terminal runs
      for (const runId of job.runIds) {
        try {
          await deps.executor.cancel(tenantId, runId);
        } catch {
          // Run may already be terminal — ignore
        }
      }

      const updated = await batchJobs.update(tenantId, job.id!, { status: "cancelled" });
      res.json(updated);
    } catch (err) { next(err); }
  });

  return router;
}
