import { WorkflowDefinitionBody, WorkflowDefinitionStatus } from "@wfe/sdk";
import { DbContext } from "../db/db-context";
import { WorkflowDefinitionEntity } from "../entities/workflow-definition";
import { WfeError } from "../errors";

export interface CreateDefinitionInput {
  tenantId: string;
  name: string;
  version: string;
  definition: WorkflowDefinitionBody;
  status?: WorkflowDefinitionStatus;
}

export class DefinitionRepository {
  constructor(private readonly db: DbContext) {}

  async create(input: CreateDefinitionInput): Promise<WorkflowDefinitionEntity> {
    const ds = await this.db.getDataSource();
    const entity = new WorkflowDefinitionEntity();
    entity.tenantId = input.tenantId;
    entity.name = input.name;
    entity.version = input.version;
    entity.definition = input.definition;
    entity.status = input.status ?? WorkflowDefinitionStatus.DRAFT;
    return ds.getRepository(WorkflowDefinitionEntity).save(entity);
  }

  async findById(tenantId: string, id: number): Promise<WorkflowDefinitionEntity | null> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowDefinitionEntity).findOneBy({ id, tenantId });
  }

  // Takes an exact version and cannot resolve a newest one, despite the name
  // this used to have ("findLatestPublished") — renamed to `findPublished`
  // since that name is honest about what it does and leaves "latest" free
  // for a future real latest-version lookup.
  async findPublished(
    tenantId: string,
    name: string,
    version: string
  ): Promise<WorkflowDefinitionEntity | null> {
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowDefinitionEntity).findOneBy({
      tenantId,
      name,
      version,
      status: WorkflowDefinitionStatus.PUBLISHED,
    });
  }

  async list(
    tenantId: string,
    opts: { status?: string; name?: string; limit?: number; offset?: number } = {}
  ): Promise<{ rows: WorkflowDefinitionEntity[]; total: number }> {
    const ds = await this.db.getDataSource();
    const repo = ds.getRepository(WorkflowDefinitionEntity);
    const qb = repo.createQueryBuilder("d").where("d.tenantId = :tenantId", { tenantId });

    if (opts.status) qb.andWhere("d.status = :status", { status: opts.status });
    if (opts.name) qb.andWhere("d.name ILIKE :name", { name: `%${opts.name}%` });

    qb.orderBy("d.updatedDate", "DESC");
    qb.skip(opts.offset ?? 0).take(opts.limit ?? 50);

    const [rows, total] = await qb.getManyAndCount();
    return { rows, total };
  }

  async update(
    tenantId: string,
    id: number,
    input: { definition?: WorkflowDefinitionBody; name?: string; version?: string }
  ): Promise<WorkflowDefinitionEntity> {
    const ds = await this.db.getDataSource();
    const existing = await this.findById(tenantId, id);
    if (!existing) {
      throw new WfeError(`Definition ${id} not found`, { statusCode: 404, code: "DEFINITION_NOT_FOUND" });
    }

    if (existing.status !== WorkflowDefinitionStatus.DRAFT) {
      throw new WfeError(
        `Definition ${id} is ${existing.status} and cannot be edited`,
        { statusCode: 400, code: "DEFINITION_NOT_EDITABLE" }
      );
    }

    existing.lastUpdateHistory = {
      definition: existing.definition,
      updatedDate: existing.updatedDate?.toISOString(),
    };

    if (input.definition) existing.definition = input.definition;
    if (input.name) existing.name = input.name;
    if (input.version) existing.version = input.version;

    return ds.getRepository(WorkflowDefinitionEntity).save(existing);
  }

  async publish(tenantId: string, id: number): Promise<WorkflowDefinitionEntity> {
    const existing = await this.findById(tenantId, id);
    if (!existing) {
      throw new WfeError(`Definition ${id} not found`, { statusCode: 404, code: "DEFINITION_NOT_FOUND" });
    }

    const lifecycle: Record<string, WorkflowDefinitionStatus> = {
      [WorkflowDefinitionStatus.DRAFT]: WorkflowDefinitionStatus.PUBLISHED,
      [WorkflowDefinitionStatus.PUBLISHED]: WorkflowDefinitionStatus.ARCHIVED,
    };

    const next = lifecycle[existing.status];
    if (!next) {
      throw new WfeError(
        `Definition ${id} is ${existing.status} and cannot be published`,
        { statusCode: 400, code: "DEFINITION_LIFECYCLE_INVALID" }
      );
    }

    existing.status = next;
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowDefinitionEntity).save(existing);
  }

  async findByIds(tenantId: string, ids: number[]): Promise<WorkflowDefinitionEntity[]> {
    if (ids.length === 0) return [];
    const ds = await this.db.getDataSource();
    return ds.getRepository(WorkflowDefinitionEntity)
      .createQueryBuilder("d")
      .where("d.tenantId = :tenantId", { tenantId })
      .andWhere("d.id IN (:...ids)", { ids })
      .getMany();
  }
}
