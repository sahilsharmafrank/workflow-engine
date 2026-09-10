import { WorkflowParameters, WorkflowRunLike, WorkflowStatus } from "@wfe/sdk";
import {
  AfterLoad, BeforeInsert, BeforeUpdate, Column, CreateDateColumn, Entity, OneToMany,
  PrimaryGeneratedColumn, UpdateDateColumn, VersionColumn,
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

  /**
   * Set when this run was started by a core.subWorkflow step rather than
   * through the normal entry points. Nullable: a normally-started run has no
   * parent. Beyond feeding the depth guard (see `depth` below and
   * WorkflowManager.startWorkflow), this is what Phase 5's UI will use to
   * show a run's children.
   */
  @Column({ type: "int", nullable: true })
  parentRunId?: number;

  /**
   * Nesting depth in the parent chain: 0 for a normally-started run,
   * parent.depth + 1 for a child started via core.subWorkflow. Bounded by
   * WFE_MAX_SUBWORKFLOW_DEPTH so a self-starting (or mutually-recursive)
   * definition cannot recurse without limit — auth is deliberately `none` in
   * v1, so any definition author can otherwise trigger this.
   */
  @Column({ type: "int", nullable: false, default: 0 })
  depth!: number;

  @Column({ type: "varchar", length: 256, nullable: false })
  name!: string;

  @Column({ type: "varchar", length: 50, nullable: false })
  version!: string;

  /**
   * Optimistic-lock counter incremented by TypeORM on every save; a stale value
   * makes the UPDATE match zero rows. Named `revision`, NOT `version`, because
   * `version` on this entity already holds the workflow definition's version
   * string and is load-bearing in the executor and the SDK's WorkflowRunLike.
   */
  @VersionColumn()
  revision!: number;

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

  @Column({ type: "jsonb", nullable: true })
  definitionSnapshotJson?: unknown;

  @OneToMany(() => StepRun, (step) => step.run, { eager: true, cascade: true })
  stepRuns?: StepRun[];

  // Transient — shuttled to and from the jsonb columns.
  inputs: WorkflowParameters = {};
  outputs: WorkflowParameters = {};
  state: WorkflowParameters = {};
  definitionSnapshot?: import("@wfe/sdk").WorkflowDefinitionBody;

  @BeforeInsert()
  @BeforeUpdate()
  copyParametersToJson(): void {
    this.inputsJson = this.inputs;
    this.outputsJson = this.outputs;
    this.stateJson = this.state;
    this.definitionSnapshotJson = this.definitionSnapshot;
  }

  @AfterLoad()
  loadParametersFromJson(): void {
    this.inputs = this.inputsJson ?? {};
    this.outputs = this.outputsJson ?? {};
    this.state = this.stateJson ?? {};
    this.definitionSnapshot = (this.definitionSnapshotJson as import("@wfe/sdk").WorkflowDefinitionBody) ?? undefined;
    this.stepRuns = this.stepRuns?.sort((a, b) => a.stepNumber - b.stepNumber);
  }

  @CreateDateColumn()
  createdDate!: Date;

  @UpdateDateColumn()
  updatedDate!: Date;
}
