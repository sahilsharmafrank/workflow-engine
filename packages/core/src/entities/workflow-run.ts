import { WorkflowParameters, WorkflowRunLike, WorkflowStatus } from "@wfe/sdk";
import {
  AfterLoad, BeforeInsert, BeforeUpdate, Column, CreateDateColumn, Entity, OneToMany,
  PrimaryGeneratedColumn, UpdateDateColumn,
} from "typeorm";
import { StepRun } from "./step-run";

@Entity({ name: "workflow_run" })
export class WorkflowRun implements WorkflowRunLike {
  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: "varchar", length: 64, nullable: false, default: "default" })
  tenantId!: string;

  @Column({ type: "int", nullable: true })
  definitionId?: number;

  @Column({ type: "varchar", length: 256, nullable: false })
  name!: string;

  @Column({ type: "varchar", length: 50, nullable: false })
  version!: string;

  @Column({ type: "int", nullable: false })
  currentStep!: number;

  @Column({ type: "varchar", length: 50, nullable: false })
  status!: WorkflowStatus;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  inputsJson?: WorkflowParameters;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  outputsJson?: WorkflowParameters;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  stateJson?: WorkflowParameters;

  @OneToMany(() => StepRun, (step) => step.run, { eager: true, cascade: true })
  stepRuns?: StepRun[];

  // Transient — shuttled to and from the jsonb columns.
  inputs: WorkflowParameters = {};
  outputs: WorkflowParameters = {};
  state: WorkflowParameters = {};

  @BeforeInsert()
  @BeforeUpdate()
  copyParametersToJson(): void {
    this.inputsJson = this.inputs;
    this.outputsJson = this.outputs;
    this.stateJson = this.state;
  }

  @AfterLoad()
  loadParametersFromJson(): void {
    this.inputs = this.inputsJson ?? {};
    this.outputs = this.outputsJson ?? {};
    this.state = this.stateJson ?? {};
    this.stepRuns = this.stepRuns?.sort((a, b) => a.stepNumber - b.stepNumber);
  }

  @CreateDateColumn()
  createdDate!: Date;

  @UpdateDateColumn()
  updatedDate!: Date;
}
