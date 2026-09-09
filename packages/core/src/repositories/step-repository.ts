import { WorkflowParameters, WorkflowStatus } from "@wfe/sdk";
import { DbContext } from "../db/db-context";
import { StepRun } from "../entities/step-run";
import { WfeError } from "../errors";

export class StepRepository {
  constructor(private readonly db: DbContext) {}

  /**
   * Claims the next step waiting for an external service. Ordered by priority
   * (highest first, nulls last) then by creation date. Used by
   * `GET /steps/next`.
   */
  async claimNext(
    tenantId: string,
    service: string,
  ): Promise<StepRun | null> {
    const ds = await this.db.getDataSource();
    const step = await ds.getRepository(StepRun)
      .createQueryBuilder("s")
      .where("s.tenantId = :tenantId", { tenantId })
      .andWhere("s.status = :status", { status: WorkflowStatus.WAITING })
      .andWhere("s.externalServiceName = :service", { service })
      .orderBy("s.priority", "DESC", "NULLS LAST")
      .addOrderBy("s.createdDate", "ASC")
      .getOne();
    return step;
  }

  async search(
    tenantId: string,
    filter: { status?: string; externalServiceName?: string; runId?: number }
  ): Promise<StepRun[]> {
    const ds = await this.db.getDataSource();
    const qb = ds.getRepository(StepRun).createQueryBuilder("s")
      .where("s.tenantId = :tenantId", { tenantId });

    if (filter.status) qb.andWhere("s.status = :status", { status: filter.status });
    if (filter.externalServiceName) {
      qb.andWhere("s.externalServiceName = :esn", { esn: filter.externalServiceName });
    }
    if (filter.runId) qb.andWhere("s.runId = :runId", { runId: filter.runId });

    qb.orderBy("s.createdDate", "DESC").take(100);
    return qb.getMany();
  }

  async findById(tenantId: string, id: number): Promise<StepRun | null> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(StepRun).findOneBy({ id, tenantId });
  }

  async updateState(tenantId: string, id: number, state: WorkflowParameters): Promise<StepRun> {
    const step = await this.findById(tenantId, id);
    if (!step) throw new WfeError(`Step ${id} not found`, { statusCode: 404, code: "STEP_NOT_FOUND" });
    step.state = state;
    const ds = await this.db.getDataSource();
    return ds.getRepository(StepRun).save(step);
  }

  async updateInputsOutputs(
    tenantId: string, id: number, inputs: WorkflowParameters, outputs: WorkflowParameters
  ): Promise<StepRun> {
    const step = await this.findById(tenantId, id);
    if (!step) throw new WfeError(`Step ${id} not found`, { statusCode: 404, code: "STEP_NOT_FOUND" });
    step.inputs = inputs;
    step.outputs = outputs;
    const ds = await this.db.getDataSource();
    return ds.getRepository(StepRun).save(step);
  }

  async updatePriority(tenantId: string, id: number, priority: number): Promise<StepRun> {
    const step = await this.findById(tenantId, id);
    if (!step) throw new WfeError(`Step ${id} not found`, { statusCode: 404, code: "STEP_NOT_FOUND" });
    step.priority = priority;
    const ds = await this.db.getDataSource();
    return ds.getRepository(StepRun).save(step);
  }
}
