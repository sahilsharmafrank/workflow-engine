import { MigrationInterface, QueryRunner } from "typeorm";

export class ServerSupport0003 implements MigrationInterface {
  name = "ServerSupport1788900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idempotency_key (
        id SERIAL PRIMARY KEY,
        tenant_id varchar(64) NOT NULL,
        key varchar(255) NOT NULL,
        run_id integer NOT NULL REFERENCES workflow_run(id),
        created_date TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT uq_idempotency_key UNIQUE (tenant_id, key)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS idempotency_key CASCADE`);
  }
}
