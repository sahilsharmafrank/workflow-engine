import {
  AfterLoad, BeforeInsert, BeforeUpdate, Column, CreateDateColumn,
  Entity, PrimaryGeneratedColumn, UpdateDateColumn,
} from "typeorm";

@Entity({ name: "batch_job" })
export class BatchJob {
  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: "varchar", length: 64, nullable: false, default: "default" })
  tenantId!: string;

  @Column({ type: "varchar", length: 256, nullable: false })
  name!: string;

  @Column({ type: "varchar", length: 256, nullable: false })
  definitionName!: string;

  @Column({ type: "varchar", length: 50, nullable: false })
  definitionVersion!: string;

  @Column({ type: "varchar", length: 50, nullable: false, default: "pending" })
  status!: string;

  @Column({ type: "int", nullable: false, default: 0 })
  totalCount!: number;

  @Column({ type: "jsonb", nullable: false, default: () => "'[]'::jsonb" })
  inputsJson?: unknown[];

  @Column({ type: "jsonb", nullable: false, default: () => "'[]'::jsonb" })
  runIdsJson?: number[];

  @Column({ type: "varchar", length: 4000, nullable: true })
  message?: string;

  // Transient
  inputs: unknown[] = [];
  runIds: number[] = [];

  @BeforeInsert()
  @BeforeUpdate()
  copyToJson(): void {
    this.inputsJson = this.inputs;
    this.runIdsJson = this.runIds;
  }

  @AfterLoad()
  loadFromJson(): void {
    this.inputs = (this.inputsJson as unknown[]) ?? [];
    this.runIds = (this.runIdsJson as number[]) ?? [];
  }

  @CreateDateColumn()
  createdDate!: Date;

  @UpdateDateColumn()
  updatedDate!: Date;
}
