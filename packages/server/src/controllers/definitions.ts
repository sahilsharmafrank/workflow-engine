import { Router } from "express";
import {
  DefinitionRepository, DbContext, StepRegistry,
  validateDefinitionShape, validateAgainstRegistry,
} from "@wfe/core";
import { AuthenticatedRequest } from "../auth/types";

export function definitionRoutes(deps: { db: DbContext; registry: StepRegistry }): Router {
  const router = Router();
  const definitions = new DefinitionRepository(deps.db);

  router.get("/definitions", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { status, name, limit, offset } = req.query;
      const result = await definitions.list(tenantId, {
        status: status as string | undefined,
        name: name as string | undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post("/definitions", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const body = await validateDefinitionShape(req.body.definition);
      validateAgainstRegistry(body, deps.registry);
      const entity = await definitions.create({
        tenantId,
        name: req.body.name,
        version: req.body.version,
        definition: body,
      });
      res.status(201).json(entity);
    } catch (err) { next(err); }
  });

  router.get("/definitions/:id", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const id = Number(req.params.id);
      const entity = await definitions.findById(tenantId, id);
      if (!entity) {
        res.status(404).json({ error: { code: "DEFINITION_NOT_FOUND", message: `Definition ${id} not found` } });
        return;
      }
      res.json(entity);
    } catch (err) { next(err); }
  });

  router.put("/definitions/:id", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const id = Number(req.params.id);
      let definition = req.body.definition;
      if (definition) {
        definition = await validateDefinitionShape(definition);
        validateAgainstRegistry(definition, deps.registry);
      }
      const updated = await definitions.update(tenantId, id, {
        definition, name: req.body.name, version: req.body.version,
      });
      res.json(updated);
    } catch (err) { next(err); }
  });

  router.post("/definitions/:id/publish", async (req, res, next) => {
    try {
      const { tenantId } = req as unknown as AuthenticatedRequest;
      const id = Number(req.params.id);
      const published = await definitions.publish(tenantId, id);
      res.json(published);
    } catch (err) { next(err); }
  });

  router.post("/definitions/import", async (req, res, next) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const items = Array.isArray(req.body) ? req.body : [req.body];
      let imported = 0;
      for (const item of items) {
        const body = await validateDefinitionShape(item.definition);
        validateAgainstRegistry(body, deps.registry);
        await definitions.create({
          tenantId, name: item.name, version: item.version, definition: body,
          status: item.status,
        });
        imported += 1;
      }
      res.status(201).json({ imported });
    } catch (err) { next(err); }
  });

  return router;
}
