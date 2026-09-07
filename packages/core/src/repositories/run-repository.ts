import { WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../db/db-context";
import { WorkflowRun } from "../entities/workflow-run";

export class RunRepository {
  constructor(private readonly db: DbContext) {}

  async save(run: WorkflowRun): Promise<WorkflowRun> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowRun).save(run);
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
