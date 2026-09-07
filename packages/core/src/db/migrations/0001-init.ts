import { MigrationInterface, QueryRunner } from "typeorm";

export class Init0001 implements MigrationInterface {
  // TypeORM requires a migration's recorded name to end in a numeric (epoch ms)
  // timestamp so migrations can be ordered; the filename/class name carry the
  // human-readable "0001-init" identity instead.
  name = "Init1788755800916";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE workflow_definition (
        id SERIAL PRIMARY KEY,
        tenant_id varchar(64) NOT NULL DEFAULT 'default',
        name varchar(255) NOT NULL,
        version varchar(20) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'draft',
        definition jsonb NOT NULL,
        last_update_history jsonb,
        created_date TIMESTAMP NOT NULL DEFAULT now(),
        updated_date TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT uq_workflow_definition UNIQUE (tenant_id, name, version)
      )`);

    await queryRunner.query(`
      CREATE TABLE workflow_run (
        id SERIAL PRIMARY KEY,
        tenant_id varchar(64) NOT NULL DEFAULT 'default',
        definition_id integer REFERENCES workflow_definition(id),
        name varchar(256) NOT NULL,
        version varchar(50) NOT NULL,
        current_step integer NOT NULL,
        status varchar(50) NOT NULL,
        inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        outputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_date TIMESTAMP NOT NULL DEFAULT now(),
        updated_date TIMESTAMP NOT NULL DEFAULT now()
      )`);

    await queryRunner.query(
      `CREATE INDEX idx_workflow_run_tenant_status ON workflow_run (tenant_id, status, updated_date)`
    );
    await queryRunner.query(
      `CREATE INDEX idx_workflow_run_tenant_name ON workflow_run (tenant_id, name, version)`
    );
    await queryRunner.query(
      `CREATE INDEX idx_workflow_run_inputs ON workflow_run USING GIN (inputs_json)`
    );

    await queryRunner.query(`
      CREATE TABLE step_run (
        id SERIAL PRIMARY KEY,
        run_id integer NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
        step_number integer NOT NULL,
        step_name varchar(200) NOT NULL,
        step_type varchar(200) NOT NULL,
        status varchar(50) NOT NULL,
        message varchar(4000),
        inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        outputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        external_service_name text,
        target_agent text,
        priority integer,
        remote_task_status text,
        original_run_id integer,
        last_step_action timestamptz,
        progress_units varchar(50),
        progress_total_expected bigint,
        progress_current_progress bigint,
        created_date TIMESTAMP NOT NULL DEFAULT now(),
        updated_date TIMESTAMP NOT NULL DEFAULT now()
      )`);

    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_step_run_run_step ON step_run (run_id, step_number)`
    );
    await queryRunner.query(
      `CREATE INDEX idx_step_run_claim ON step_run (status, external_service_name, priority)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS step_run CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS workflow_run CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS workflow_definition CASCADE`);
  }
}
