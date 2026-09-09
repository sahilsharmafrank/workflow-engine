import { MigrationInterface, QueryRunner } from "typeorm";

export class DefinitionSnapshot0004 implements MigrationInterface {
  name = "DefinitionSnapshot1789000000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE workflow_run ADD COLUMN definition_snapshot_json jsonb`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE workflow_run DROP COLUMN definition_snapshot_json`);
  }
}
