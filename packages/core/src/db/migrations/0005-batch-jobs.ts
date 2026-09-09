import { MigrationInterface, QueryRunner, Table } from "typeorm";

export class BatchJobs0005 implements MigrationInterface {
  name = "BatchJobs1789100000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(new Table({
      name: "batch_job",
      columns: [
        { name: "id", type: "serial", isPrimary: true },
        { name: "tenant_id", type: "varchar", length: "64", isNullable: false, default: "'default'" },
        { name: "name", type: "varchar", length: "256", isNullable: false },
        { name: "definition_name", type: "varchar", length: "256", isNullable: false },
        { name: "definition_version", type: "varchar", length: "50", isNullable: false },
        { name: "status", type: "varchar", length: "50", isNullable: false, default: "'pending'" },
        { name: "total_count", type: "int", isNullable: false, default: "0" },
        { name: "inputs_json", type: "jsonb", isNullable: false, default: "'[]'::jsonb" },
        { name: "run_ids_json", type: "jsonb", isNullable: false, default: "'[]'::jsonb" },
        { name: "message", type: "varchar", length: "4000", isNullable: true },
        { name: "created_date", type: "timestamptz", default: "now()" },
        { name: "updated_date", type: "timestamptz", default: "now()" },
      ],
      indices: [
        { columnNames: ["tenant_id", "status"] },
      ],
    }));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("batch_job");
  }
}
