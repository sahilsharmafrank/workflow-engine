import { StepRunLike, WorkflowParameters, WorkflowStatus } from "@wfe/sdk";
import {
  AfterLoad, BeforeInsert, BeforeUpdate, Column, CreateDateColumn, Entity, JoinColumn,
  ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn,
} from "typeorm";
import { Progress } from "./progress";
import { WorkflowRun } from "./workflow-run";

// Caps the human-facing message before persist so an over-length message cannot
// overflow the column and mask the real error with a database write error. Full
// detail always remains in outputsJson. The margin below the 4000-character column
// accounts for the appended ellipsis and for UTF-16 code units vs characters.
const MAX_MESSAGE_LENGTH = 3900;

@Entity({ name: "step_run" })
export class StepRun implements StepRunLike {
  @PrimaryGeneratedColumn()
  id?: number;

  // Mirror of the FK for reading the value without a join. The FK is owned by
  // the @ManyToOne + @JoinColumn relation below; both declarations resolve to
  // the same physical "run_id" column, which is how TypeORM lets you read/write
  // it either as a plain scalar or through the relation. The column is NOT NULL
  // in the migration — a step row without a run is meaningless — so this says
  // the same.
  @Column({ type: "int", nullable: false })
  runId!: number;

  @Column({ type: "varchar", length: 64, nullable: false, default: "default" })
  tenantId!: string;

  @Column({ type: "int", nullable: false })
  stepNumber!: number;

  @Column({ type: "varchar", length: 200, nullable: false })
  stepName!: string;

  @Column({ type: "varchar", length: 200, nullable: false })
  stepType!: string;

  @Column({ type: "varchar", length: 50, nullable: false })
  status!: WorkflowStatus;

  @Column({ type: "varchar", length: 4000, nullable: true })
  message?: string;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  inputsJson?: WorkflowParameters;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  outputsJson?: WorkflowParameters;

  @Column({ type: "jsonb", nullable: false, default: () => "'{}'::jsonb" })
  stateJson?: WorkflowParameters;

  @Column({ type: "text", nullable: true })
  externalServiceName?: string;

  @Column({ type: "text", nullable: true })
  targetAgent?: string;

  @Column({ type: "int", nullable: true })
  priority?: number;

  @Column({ type: "text", nullable: true })
  remoteTaskStatus?: string;

  @Column({ type: "int", nullable: true })
  originalRunId?: number;

  @Column({ type: "timestamptz", nullable: true })
  lastStepAction?: Date;

  @Column(() => Progress)
  progress?: Progress;

  @ManyToOne(() => WorkflowRun, (run) => run.stepRuns, { onDelete: "CASCADE" })
  @JoinColumn({ name: "run_id" })
  run?: WorkflowRun;

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

  @BeforeInsert()
  @BeforeUpdate()
  truncateMessage(): void {
    if (this.message && this.message.length > MAX_MESSAGE_LENGTH) {
      this.message = `${this.message.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
    }
  }

  @AfterLoad()
  loadParametersFromJson(): void {
    this.inputs = this.inputsJson ?? {};
    this.outputs = this.outputsJson ?? {};
    this.state = this.stateJson ?? {};
  }

  @CreateDateColumn()
  createdDate!: Date;

  @UpdateDateColumn()
  updatedDate!: Date;
}
