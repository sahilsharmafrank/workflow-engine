import "reflect-metadata";
import { DataSource, DataSourceOptions } from "typeorm";
import { SnakeNamingStrategy } from "typeorm-naming-strategies";
import { EngineConfig } from "../config";
import { StepRun } from "../entities/step-run";
import { WorkflowDefinitionEntity } from "../entities/workflow-definition";
import { WorkflowRun } from "../entities/workflow-run";
import { Init0001 } from "./migrations/0001-init";

export function connectionOptions(config: EngineConfig): DataSourceOptions {
  return {
    type: "postgres",
    url: config.dbUrl,
    namingStrategy: new SnakeNamingStrategy(),
    entities: [WorkflowDefinitionEntity, WorkflowRun, StepRun],
    migrations: [Init0001],
    synchronize: false,
    logging: config.showSql ?? false,
  };
}

export class DbContext {
  private dataSource?: DataSource;

  constructor(private readonly config: EngineConfig) {}

  async getDataSource(): Promise<DataSource> {
    if (!this.dataSource) {
      this.dataSource = await new DataSource(connectionOptions(this.config)).initialize();
    }
    return this.dataSource;
  }

  async runMigrations(): Promise<void> {
    const ds = await this.getDataSource();
    await ds.runMigrations({ transaction: "each" });
  }

  async close(): Promise<void> {
    if (this.dataSource?.isInitialized) {
      await this.dataSource.destroy();
    }
    this.dataSource = undefined;
  }
}
