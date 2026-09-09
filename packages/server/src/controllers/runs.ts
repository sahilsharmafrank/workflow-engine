import { Router } from "express";
import {
  RunExecutor, RunRepository, DbContext, IdempotencyKeyEntity,
} from "@wfe/core";
import { AuthenticatedRequest } from "../auth/types";

export function runRoutes(deps: { executor: RunExecutor; db: DbContext }): Router {
  const router = Router();
  const runs = new RunRepository(deps.db);

  router.post("/runs", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { name, version, inputs } = req.body;
      const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

      if (idempotencyKey) {
        const ds = await deps.db.getDataSource();
        const existing = await ds.getRepository(IdempotencyKeyEntity).findOneBy({
          tenantId, key: idempotencyKey,
        });
        if (existing) {
          const run = await runs.findById(tenantId, existing.runId);
          res.status(200).json({ runId: existing.runId, status: run?.status ?? "unknown" });
          return;
        }
      }

      const runId = await deps.executor.startWorkflow({ tenantId, name, version, inputs: inputs ?? {} });
      const run = await deps.executor.start(tenantId, runId);

      if (idempotencyKey) {
        const ds = await deps.db.getDataSource();
        const key = new IdempotencyKeyEntity();
        key.tenantId = tenantId;
        key.key = idempotencyKey;
        key.runId = runId;
        await ds.getRepository(IdempotencyKeyEntity).save(key);
      }

      res.status(201).json({ runId, status: run.status });
    } catch (err) { next(err); }
  });

  router.get("/runs", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { status, name, limit, offset } = req.query;
      const result = await runs.list(tenantId, {
        status: status as string | undefined,
        name: name as string | undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post("/runs/search", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const results = await runs.search(tenantId, req.body.filter ?? {});
      res.json(results);
    } catch (err) { next(err); }
  });

  router.post("/runs/by-ids", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const results = await runs.findByIds(tenantId, req.body.ids ?? []);
      res.json(results);
    } catch (err) { next(err); }
  });

  router.get("/runs/:id", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const run = await runs.findById(tenantId, Number(req.params.id));
      if (!run) {
        res.status(404).json({ error: { code: "RUN_NOT_FOUND", message: `Run ${req.params.id} not found` } });
        return;
      }
      res.json(run);
    } catch (err) { next(err); }
  });

  router.put("/runs/:id/cancel", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const run = await deps.executor.cancel(tenantId, Number(req.params.id));
      res.json(run);
    } catch (err) { next(err); }
  });

  router.put("/runs/:id/restart/step/:n", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const run = await deps.executor.restartFromStep(
        tenantId, Number(req.params.id), Number(req.params.n)
      );
      res.json(run);
    } catch (err) { next(err); }
  });

  router.put("/runs/:id/callback", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const { stepNumber, body } = req.body;
      const run = await deps.executor.callback(
        tenantId, Number(req.params.id), stepNumber, body
      );
      res.json(run);
    } catch (err) { next(err); }
  });

  router.put("/runs/:id/inputs", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const run = await runs.updateInputs(tenantId, Number(req.params.id), req.body.inputs ?? {});
      res.json(run);
    } catch (err) { next(err); }
  });

  return router;
}
