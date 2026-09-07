import { StepProgress } from "@wfe/sdk";
import { Column } from "typeorm";

export class Progress implements StepProgress {
  @Column({ type: "varchar", length: 50, nullable: true })
  units?: string;

  @Column({ type: "bigint", nullable: true })
  totalExpected?: number;

  @Column({ type: "bigint", nullable: true })
  currentProgress?: number;
}
