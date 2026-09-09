import { WorkflowParameters, WorkflowStatus } from "@wfe/sdk";
import { QueryFailedError } from "typeorm";
import { DbContext } from "../db/db-context";
import { StepRun } from "../entities/step-run";
import { WorkflowRun } from "../entities/workflow-run";
import { WfeError } from "../errors";

// Postgres SQLSTATE for a statement that exceeded `lock_timeout` while
// waiting on a row lock (`lock_not_available`).
const PG_LOCK_NOT_AVAILABLE = "55P03";

export class RunRepository {
  constructor(private readonly db: DbContext) {}

  async save(run: WorkflowRun): Promise<WorkflowRun> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowRun).save(run);
  }

  /**
   * Saves `run` together with any populated `stepRuns`, one query at a time.
   *
   * `WorkflowRun.stepRuns` cascades (`cascade: true`), so a plain `save(run)`
   * with more than one modified step (e.g. restarting from an early step
   * resets it and every step after it) hands TypeORM's `SubjectExecutor` more
   * than one UPDATE subject. `executeUpdateOperations` fires those with
   * `Promise.all`, and since every subject in one `save()` call shares the
   * same `QueryRunner` — and therefore the same underlying `pg` `Client` —
   * the second query starts before the first's response has arrived. `pg`
   * queues it rather than failing, but logs the "client.query() when the
   * client is already executing a query" deprecation (removed in pg@9).
   *
   * Saving each step first, sequentially awaited, then saving the run with
   * `stepRuns` temporarily cleared keeps every query on this connection
   * strictly one-at-a-time. Both loop and final save run inside one
   * transaction, so this stays atomic like the single-call version did.
   */
  async saveWithSteps(run: WorkflowRun): Promise<WorkflowRun> {
    const ds = await this.db.getDataSource();
    const steps = run.stepRuns;
    return ds.manager.transaction(async (manager) => {
      for (const step of steps ?? []) {
        await manager.getRepository(StepRun).save(step);
      }
      run.stepRuns = undefined;
      try {
        const saved = await manager.getRepository(WorkflowRun).save(run);
        saved.stepRuns = steps;
        return saved;
      } finally {
        run.stepRuns = steps;
      }
    });
  }

  /**
   * Saves a run, failing loudly when another writer has advanced it since this
   * entity was loaded. Use this on every path a queue consumer can reach: with
   * at-least-once delivery two consumers can hold the same run, and a blind
   * save would let the loser overwrite the winner.
   *
   * NOTE on implementation: TypeORM's plain `save()` on an entity with a
   * `@VersionColumn` does NOT guard the UPDATE with a `WHERE revision = ?`
   * predicate — verified against the generated SQL, it unconditionally emits
   * `SET revision = revision + 1` with no revision check in the WHERE clause.
   * `OptimisticLockVersionMismatchError` is only ever thrown by
   * `SelectQueryBuilder`'s `setLock("optimistic", version)` path, which is a
   * post-SELECT comparison in application code, not a DB-level guard — so
   * pairing it with a blind `save()` leaves the exact TOCTOU race the task
   * exists to close (two callers can both pass the check before either
   * writes). So this takes a row lock (`SELECT ... FOR UPDATE`) inside a
   * transaction before comparing revisions: a second caller's lock
   * acquisition blocks until the first's transaction commits, then observes
   * the bumped revision and is rejected here instead of racing the UPDATE.
   *
   * The lock read is bounded by `lock_timeout` (see `DbContext.lockTimeoutMs`):
   * on a pooled connection, a locker blocked here with no bound would occupy
   * a pool slot indefinitely under redelivery-driven contention on one run,
   * stalling unrelated database work sharing the pool. A bounded wait turns
   * that into a fast, loud failure instead.
   */
  async saveChecked(run: WorkflowRun): Promise<WorkflowRun> {
    const ds = await this.db.getDataSource();
    if (run.id === undefined) {
      // Nothing persisted yet for another writer to have raced against.
      return ds.getRepository(WorkflowRun).save(run);
    }

    const expectedRevision = run.revision;
    try {
      return await ds.manager.transaction(async (manager) => {
        // SET LOCAL only affects this transaction and is reset at commit/rollback.
        await manager.query(`SET LOCAL lock_timeout = '${this.db.lockTimeoutMs}ms'`);

        // A plain findOne({ lock }) here would pull in the eager stepRuns
        // relation, and Postgres rejects FOR UPDATE against the nullable side
        // of that outer join. A raw lookup of just the revision column sidesteps
        // it while still taking the row lock for the rest of this transaction.
        // Tenant-scoped like every other repository query: a caller can only
        // ever hold a WorkflowRun it read through a tenant-scoped path, but
        // this keeps that guarantee true here too instead of relying on it.
        const rows = await manager.query<Array<{ revision: number }>>(
          `SELECT revision FROM workflow_run WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [run.id, run.tenantId]
        );
        if (rows.length === 0) {
          // Not a revision conflict: either the run was deleted, or the
          // caller holds an entity that was never scoped to this tenant.
          // Distinct from RUN_CONFLICT so a caller doesn't mistake "there was
          // nothing to race against" for "another writer beat you to it".
          throw new WfeError(
            `Workflow run ${run.id} not found for tenant "${run.tenantId}"`,
            { statusCode: 404, code: "RUN_NOT_FOUND" }
          );
        }
        if (rows[0].revision !== expectedRevision) {
          throw new WfeError(
            `Workflow run ${run.id} was modified by another writer; discarding this update`,
            { statusCode: 409, code: "RUN_CONFLICT" }
          );
        }
        return manager.getRepository(WorkflowRun).save(run);
      });
    } catch (err) {
      if (err instanceof QueryFailedError && (err as unknown as { code?: string }).code === PG_LOCK_NOT_AVAILABLE) {
        throw new WfeError(
          `Timed out waiting for the lock on workflow run ${run.id}; another writer held it too long`,
          { statusCode: 503, code: "RUN_LOCK_TIMEOUT", cause: err }
        );
      }
      throw err;
    }
  }

  async findById(tenantId: string, id: number): Promise<WorkflowRun | null> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowRun).findOne({ where: { id, tenantId } });
  }

  /**
   * Reads just the status column, bypassing the eager stepRuns relation and
   * the transient-parameter jsonb columns. Used by the advance loop to detect
   * an out-of-band status change (e.g. a concurrent cancel()) without paying
   * for — or clobbering — a full row load.
   */
  async getStatus(tenantId: string, id: number): Promise<WorkflowStatus | null> {
    const ds = await this.db.getDataSource();
    const rows = await ds.query<Array<{ status: WorkflowStatus }>>(
      "SELECT status FROM workflow_run WHERE id = $1 AND tenant_id = $2",
      [id, tenantId]
    );
    return rows[0]?.status ?? null;
  }

  async list(
    tenantId: string,
    opts: { status?: string; name?: string; limit?: number; offset?: number } = {}
  ): Promise<{ rows: WorkflowRun[]; total: number }> {
    const ds = await this.db.getDataSource();
    const qb = ds.getRepository(WorkflowRun).createQueryBuilder("r")
      .where("r.tenantId = :tenantId", { tenantId });

    if (opts.status) qb.andWhere("r.status = :status", { status: opts.status });
    if (opts.name) qb.andWhere("r.name = :name", { name: opts.name });

    qb.orderBy("r.updatedDate", "DESC");
    qb.skip(opts.offset ?? 0).take(opts.limit ?? 50);

    const [rows, total] = await qb.getManyAndCount();
    return { rows, total };
  }

  async search(tenantId: string, filter: Record<string, unknown>): Promise<WorkflowRun[]> {
    const ds = await this.db.getDataSource();
    const qb = ds.getRepository(WorkflowRun).createQueryBuilder("r")
      .where("r.tenantId = :tenantId", { tenantId });

    // Each key like "inputs.foo" becomes a jsonb containment check
    for (const [key, value] of Object.entries(filter)) {
      const [column, ...path] = key.split(".");
      const jsonColumn = `${column}Json`;
      const paramName = `filter_${path.join("_")}`;
      if (path.length > 0) {
        const nested = path.reduceRight<unknown>((acc, k) => ({ [k]: acc }), value);
        qb.andWhere(`r.${jsonColumn} @> :${paramName}`, {
          [paramName]: JSON.stringify(nested),
        });
      }
    }

    qb.orderBy("r.updatedDate", "DESC").take(100);
    return qb.getMany();
  }

  async findByIds(tenantId: string, ids: number[]): Promise<WorkflowRun[]> {
    if (ids.length === 0) return [];
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowRun).createQueryBuilder("r")
      .where("r.tenantId = :tenantId", { tenantId })
      .andWhere("r.id IN (:...ids)", { ids })
      .getMany();
  }

  async updateInputs(tenantId: string, id: number, inputs: WorkflowParameters): Promise<WorkflowRun> {
    const run = await this.findById(tenantId, id);
    if (!run) {
      throw new WfeError(`Run ${id} not found`, { statusCode: 404, code: "RUN_NOT_FOUND" });
    }
    run.inputs = inputs;
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowRun).save(run);
  }
}
