import { MigrationInterface, QueryRunner } from "typeorm";

export class QueueSupport0002 implements MigrationInterface {
  name = "QueueSupport1788800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Optimistic concurrency: at-least-once delivery lets two consumers load
    // the same run and both pass the resume guards. Without a version, the
    // loser's blind full-row UPDATE silently overwrites the winner.
    await queryRunner.query(`ALTER TABLE workflow_run ADD COLUMN revision integer NOT NULL DEFAULT 1`);

    // step_run needs its own tenant for the tenant-scoped claim query the REST
    // API will run; joining to workflow_run for it would defeat the index.
    await queryRunner.query(`ALTER TABLE step_run ADD COLUMN tenant_id varchar(64) NOT NULL DEFAULT 'default'`);
    await queryRunner.query(
      `UPDATE step_run SET tenant_id = wr.tenant_id FROM workflow_run wr WHERE step_run.run_id = wr.id`
    );

    await queryRunner.query(`DROP INDEX IF EXISTS idx_step_run_claim`);
    await queryRunner.query(
      `CREATE INDEX idx_step_run_claim ON step_run (tenant_id, status, external_service_name, priority)`
    );
    await queryRunner.query(
      `CREATE INDEX idx_step_run_correlation ON step_run (tenant_id, remote_task_status) WHERE remote_task_status IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_step_run_correlation`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_step_run_claim`);
    await queryRunner.query(`CREATE INDEX idx_step_run_claim ON step_run (status, external_service_name, priority)`);
    await queryRunner.query(`ALTER TABLE step_run DROP COLUMN tenant_id`);
    await queryRunner.query(`ALTER TABLE workflow_run DROP COLUMN revision`);
  }
}
