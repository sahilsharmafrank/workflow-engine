import { execSync } from "child_process";
import { join } from "path";

jest.setTimeout(30000);

const cli = join(__dirname, "../src/cli/index.ts");

describe("CLI", () => {
  it("prints help without error", () => {
    const output = execSync(`npx ts-node ${cli} --help`, {
      encoding: "utf8",
      cwd: join(__dirname, "../.."),
    });
    expect(output).toContain("migrate");
    expect(output).toContain("serve");
    expect(output).toContain("worker");
    expect(output).toContain("import");
  });

  it("rejects an unknown command", () => {
    expect(() =>
      execSync(`npx ts-node ${cli} bogus 2>&1`, {
        encoding: "utf8",
        cwd: join(__dirname, "../.."),
      })
    ).toThrow();
  });
});
