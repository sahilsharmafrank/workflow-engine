import { Router } from "express";
import {
  DbContext, StepRegistry, ExpressionEvaluator, StepRepository,
  captureParameters, WorkflowRun,
} from "@wfe/core";
import { WorkflowStatus } from "@wfe/sdk";
import { AuthenticatedRequest } from "../auth/types";

export function stepRoutes(deps: {
  db: DbContext; registry: StepRegistry; evaluator: ExpressionEvaluator;
}): Router {
  const router = Router();
  const steps = new StepRepository(deps.db);

  router.get("/step-types", (req, res) => {
    const types = deps.registry.list().map((r) => ({
      type: r.type, version: r.version, description: r.description,
      inputSchema: r.inputSchema, outputSchema: r.outputSchema,
    }));
    res.json(types);
  });

  router.get("/steps/next", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const service = req.query.service as string;
      if (!service) {
        res.status(400).json({ error: { code: "MISSING_SERVICE", message: "service query parameter is required" } });
        return;
      }
      const step = await steps.claimNext(tenantId, service);
      if (!step) {
        res.status(204).end();
        return;
      }
      res.json(step);
    } catch (err) { next(err); }
  });

  router.post("/steps/search", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const result = await steps.search(tenantId, req.body);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.put("/steps/:id/state", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const step = await steps.updateState(tenantId, Number(req.params.id), req.body.state ?? {});
      res.json(step);
    } catch (err) { next(err); }
  });

  router.put("/steps/:id/inputs-outputs", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const step = await steps.updateInputsOutputs(
        tenantId, Number(req.params.id), req.body.inputs ?? {}, req.body.outputs ?? {}
      );
      res.json(step);
    } catch (err) { next(err); }
  });

  router.put("/steps/:id/priority", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const step = await steps.updatePriority(tenantId, Number(req.params.id), req.body.priority);
      res.json(step);
    } catch (err) { next(err); }
  });

  router.post("/steps/dry-run", async (req, res, next) => {
    try {
      const { expressions, state, config, body } = req.body;
      // Build a minimal run-like object for the evaluator
      const fakeRun = {
        tenantId: "default", name: "dry-run", version: "0",
        currentStep: 0, status: WorkflowStatus.RUNNING,
        inputs: state?.inputs ?? {}, outputs: state?.outputs ?? {},
        state: state?.state ?? {}, stepRuns: [],
      } as unknown as WorkflowRun;

      const result = await captureParameters({
        evaluator: deps.evaluator,
        run: fakeRun,
        expressions: expressions ?? [],
        config: config ?? {},
        body,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  return router;
}
