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
}
