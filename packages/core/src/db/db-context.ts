import "reflect-metadata";
import { DataSource, DataSourceOptions } from "typeorm";
import { SnakeNamingStrategy } from "typeorm-naming-strategies";
import { EngineConfig } from "../config";
import { IdempotencyKeyEntity } from "../entities/idempotency-key";
import { StepRun } from "../entities/step-run";
import { WorkflowDefinitionEntity } from "../entities/workflow-definition";
import { WorkflowRun } from "../entities/workflow-run";
import { Init0001 } from "./migrations/0001-init";
import { QueueSupport0002 } from "./migrations/0002-queue-support";
import { ServerSupport0003 } from "./migrations/0003-server-support";
import { DefinitionSnapshot0004 } from "./migrations/0004-definition-snapshot";

export function connectionOptions(config: EngineConfig): DataSourceOptions {
  return {
    type: "postgres",
    url: config.dbUrl,
    namingStrategy: new SnakeNamingStrategy(),
    entities: [WorkflowDefinitionEntity, WorkflowRun, StepRun, IdempotencyKeyEntity],
    migrations: [Init0001, QueueSupport0002, ServerSupport0003, DefinitionSnapshot0004],
    synchronize: false,
    logging: config.showSql ?? false,
  };
}

export class DbContext {
  // Memoizes the in-flight promise, not the resolved value: two concurrent
  // callers on a cold DbContext both see this as undefined only once, since
  // the assignment happens synchronously before either await resolves — so
  // only one DataSource/connection pool is ever constructed.
  private dataSourcePromise?: Promise<DataSource>;

  constructor(private readonly config: EngineConfig) {}

  /** Default is applied here, not just in `loadEngineConfig`, so a `DbContext` built directly from a literal (as every test does) still gets a bound instead of an unbounded wait. */
  get lockTimeoutMs(): number {
    return this.config.lockTimeoutMs ?? 5000;
  }

  async getDataSource(): Promise<DataSource> {
    // If initialize() rejects, clear the memo so the *next* call gets a fresh
    // attempt instead of the same cached rejection forever. Concurrent callers
    // in the meantime still share this one in-flight promise/rejection.
    this.dataSourcePromise ??= new DataSource(connectionOptions(this.config)).initialize().catch((err) => {
      this.dataSourcePromise = undefined;
      throw err;
    });
    return this.dataSourcePromise;
  }

  async runMigrations(): Promise<void> {
    const ds = await this.getDataSource();
    await ds.runMigrations({ transaction: "each" });
  }

  async close(): Promise<void> {
    const promise = this.dataSourcePromise;
    this.dataSourcePromise = undefined;
    if (!promise) {
      return;
    }
    const ds = await promise;
    if (ds.isInitialized) {
      await ds.destroy();
    }
  }
}
