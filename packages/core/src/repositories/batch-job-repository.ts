import { DbContext } from "../db/db-context";
import { BatchJob } from "../entities/batch-job";
import { WfeError } from "../errors";

export class BatchJobRepository {
  constructor(private readonly db: DbContext) {}

  async create(data: Partial<BatchJob>): Promise<BatchJob> {
    const ds = await this.db.getDataSource();
    const job = new BatchJob();
    Object.assign(job, data);
    return ds.getRepository(BatchJob).save(job);
  }

  async findById(tenantId: string, id: number): Promise<BatchJob | null> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(BatchJob).findOneBy({ id, tenantId });
  }

  async list(
    tenantId: string,
    filters?: { status?: string; limit?: number; offset?: number },
  ): Promise<BatchJob[]> {
    const ds = await this.db.getDataSource();
    const qb = ds.getRepository(BatchJob).createQueryBuilder("job")
      .where("job.tenantId = :tenantId", { tenantId })
      .orderBy("job.createdDate", "DESC")
      .take(filters?.limit ?? 50)
      .skip(filters?.offset ?? 0);

    if (filters?.status) {
      qb.andWhere("job.status = :status", { status: filters.status });
    }

    return qb.getMany();
  }

  async update(tenantId: string, id: number, updates: Partial<BatchJob>): Promise<BatchJob> {
    const job = await this.findById(tenantId, id);
    if (!job) {
      throw new WfeError(`Batch job ${id} not found`, { statusCode: 404, code: "BATCH_JOB_NOT_FOUND" });
    }
    Object.assign(job, updates);
    const ds = await this.db.getDataSource();
    return ds.getRepository(BatchJob).save(job);
  }

  async computeProgress(
    tenantId: string,
    id: number,
  ): Promise<{ completedCount: number; failedCount: number; runningCount: number }> {
    const job = await this.findById(tenantId, id);
    if (!job || job.runIds.length === 0) {
      return { completedCount: 0, failedCount: 0, runningCount: 0 };
    }
    const ds = await this.db.getDataSource();
    const rows: Array<{ status: string; count: string }> = await ds.query(
      `SELECT status, COUNT(*)::int AS count FROM workflow_run
       WHERE tenant_id = $1 AND id = ANY($2) GROUP BY status`,
      [tenantId, job.runIds],
    );

    let completedCount = 0;
    let failedCount = 0;
    let runningCount = 0;
    for (const row of rows) {
      if (row.status === "COMPLETE") completedCount = Number(row.count);
      else if (row.status === "FAILED") failedCount = Number(row.count);
      else if (row.status === "RUNNING" || row.status === "STARTING" || row.status === "WAITING") {
        runningCount += Number(row.count);
      }
    }
    return { completedCount, failedCount, runningCount };
  }
}
