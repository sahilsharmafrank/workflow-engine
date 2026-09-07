import { WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../db/db-context";
import { WorkflowRun } from "../entities/workflow-run";
import { WfeError } from "../errors";

export class RunRepository {
  constructor(private readonly db: DbContext) {}

  async save(run: WorkflowRun): Promise<WorkflowRun> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowRun).save(run);
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
   */
  async saveChecked(run: WorkflowRun): Promise<WorkflowRun> {
    const ds = await this.db.getDataSource();
    if (run.id === undefined) {
      // Nothing persisted yet for another writer to have raced against.
      return ds.getRepository(WorkflowRun).save(run);
    }

    const expectedRevision = run.revision;
    return ds.manager.transaction(async (manager) => {
      // A plain findOne({ lock }) here would pull in the eager stepRuns
      // relation, and Postgres rejects FOR UPDATE against the nullable side
      // of that outer join. A raw lookup of just the revision column sidesteps
      // it while still taking the row lock for the rest of this transaction.
      const rows = await manager.query<Array<{ revision: number }>>(
        `SELECT revision FROM workflow_run WHERE id = $1 FOR UPDATE`,
        [run.id]
      );
      if (rows.length === 0 || rows[0].revision !== expectedRevision) {
        throw new WfeError(
          `Workflow run ${run.id} was modified by another writer; discarding this update`,
          { statusCode: 409, code: "RUN_CONFLICT" }
        );
      }
      return manager.getRepository(WorkflowRun).save(run);
    });
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
}
