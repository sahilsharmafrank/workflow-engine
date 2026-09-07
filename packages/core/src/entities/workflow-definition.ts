import { WorkflowDefinitionBody, WorkflowDefinitionStatus } from "@wfe/sdk";
import {
  Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn,
} from "typeorm";

@Entity({ name: "workflow_definition" })
@Unique("uq_workflow_definition", ["tenantId", "name", "version"])
export class WorkflowDefinitionEntity {
  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: "varchar", length: 64, nullable: false, default: "default" })
  tenantId!: string;

  @Column({ type: "varchar", length: 255, nullable: false })
  name!: string;

  @Column({ type: "varchar", length: 20, nullable: false })
  version!: string;

  @Column({ type: "varchar", length: 20, nullable: false, default: WorkflowDefinitionStatus.DRAFT })
  status!: WorkflowDefinitionStatus;

  @Column({ type: "jsonb", nullable: false })
  definition!: WorkflowDefinitionBody;

  @Column({ type: "jsonb", nullable: true })
  lastUpdateHistory?: Record<string, unknown>;

  @CreateDateColumn()
  createdDate!: Date;

  @UpdateDateColumn()
  updatedDate!: Date;
}
