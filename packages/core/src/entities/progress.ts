import { StepProgress } from "@wfe/sdk";
import { Column, ValueTransformer } from "typeorm";

// TypeORM and the pg driver return bigint/int8 columns as JS strings by default
// to avoid silent precision loss past Number.MAX_SAFE_INTEGER. StepProgress
// (from @wfe/sdk) declares these fields as `number`, so parse on read to keep
// the runtime value honest with its own type; writes pass the number through
// unchanged (pg accepts a JS number for a bigint parameter).
const bigintToNumber: ValueTransformer = {
  to: (value?: number) => value,
  from: (value?: string | null) => (value === null || value === undefined ? value : Number(value)),
};

export class Progress implements StepProgress {
  @Column({ type: "varchar", length: 50, nullable: true })
  units?: string;

  @Column({ type: "bigint", nullable: true, transformer: bigintToNumber })
  totalExpected?: number;

  @Column({ type: "bigint", nullable: true, transformer: bigintToNumber })
  currentProgress?: number;
}
