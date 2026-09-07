import { WorkflowDefinitionBody, WorkflowDefinitionStatus } from "@wfe/sdk";
import { DbContext } from "../db/db-context";
import { WorkflowDefinitionEntity } from "../entities/workflow-definition";

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
}
