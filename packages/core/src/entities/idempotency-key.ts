import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from "typeorm";

@Entity({ name: "idempotency_key" })
@Unique("uq_idempotency_key", ["tenantId", "key"])
export class IdempotencyKeyEntity {
  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: "varchar", length: 64, nullable: false })
  tenantId!: string;

  @Column({ type: "varchar", length: 255, nullable: false })
  key!: string;

  @Column({ type: "int", nullable: false })
  runId!: number;

  @CreateDateColumn()
  createdDate!: Date;
}
