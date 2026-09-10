import { MigrationInterface, QueryRunner } from "typeorm";

export class SubWorkflowLineage0006 implements MigrationInterface {
  name = "SubWorkflowLineage1789200000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE workflow_run ADD COLUMN parent_run_id integer REFERENCES workflow_run(id)`
    );
    await queryRunner.query(
      `ALTER TABLE workflow_run ADD COLUMN depth integer NOT NULL DEFAULT 0`
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE workflow_run DROP COLUMN depth`);
    await queryRunner.query(`ALTER TABLE workflow_run DROP COLUMN parent_run_id`);
  }
}
