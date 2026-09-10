import { isHttpAllowPrivateHosts, loadEngineConfig } from "../src/config";

describe("loadEngineConfig", () => {
  const baseEnv = { WFE_DB_URL: "postgres://localhost:5432/wfe" };

  it("throws when WFE_DB_URL is missing", () => {
    expect(() => loadEngineConfig({})).toThrow(/WFE_DB_URL/);
  });

  it("defaults the expression timeout to 100ms", () => {
    const config = loadEngineConfig(baseEnv);
    expect(config.expressionTimeoutMs).toBe(100);
  });

  it("accepts a positive expression timeout override", () => {
    const config = loadEngineConfig({ ...baseEnv, WFE_EXPRESSION_TIMEOUT_MS: "250" });
    expect(config.expressionTimeoutMs).toBe(250);
  });

  // Without this validation, 0 and negative values fail OPEN: isolated-vm
  // treats a non-positive timeout as "no timeout", silently disabling the
  // only DoS control expressions have.
  it("rejects a zero expression timeout at boot time", () => {
    expect(() => loadEngineConfig({ ...baseEnv, WFE_EXPRESSION_TIMEOUT_MS: "0" })).toThrow(
      /WFE_EXPRESSION_TIMEOUT_MS/
    );
  });

  it("rejects a negative expression timeout at boot time", () => {
    expect(() => loadEngineConfig({ ...baseEnv, WFE_EXPRESSION_TIMEOUT_MS: "-50" })).toThrow(
      /WFE_EXPRESSION_TIMEOUT_MS/
    );
  });

  it("rejects a non-numeric expression timeout at boot time", () => {
    expect(() => loadEngineConfig({ ...baseEnv, WFE_EXPRESSION_TIMEOUT_MS: "not-a-number" })).toThrow(
      /WFE_EXPRESSION_TIMEOUT_MS/
    );
  });

  // core.http's SSRF guard (see http-step.ts) must fail closed: anything
  // other than the literal string "true" leaves private hosts blocked.
  it("defaults httpAllowPrivateHosts to false", () => {
    expect(loadEngineConfig(baseEnv).httpAllowPrivateHosts).toBe(false);
    expect(isHttpAllowPrivateHosts(baseEnv)).toBe(false);
  });

  it("enables httpAllowPrivateHosts only for the literal string \"true\"", () => {
    expect(loadEngineConfig({ ...baseEnv, WFE_HTTP_ALLOW_PRIVATE_HOSTS: "true" }).httpAllowPrivateHosts).toBe(true);
    expect(isHttpAllowPrivateHosts({ ...baseEnv, WFE_HTTP_ALLOW_PRIVATE_HOSTS: "true" })).toBe(true);
    expect(isHttpAllowPrivateHosts({ ...baseEnv, WFE_HTTP_ALLOW_PRIVATE_HOSTS: "TRUE" })).toBe(false);
    expect(isHttpAllowPrivateHosts({ ...baseEnv, WFE_HTTP_ALLOW_PRIVATE_HOSTS: "1" })).toBe(false);
  });

  // core.subWorkflow's recursion guard (see WorkflowManager.startWorkflow)
  // must have a sane default, since auth is deliberately `none` in v1 and
  // any definition author could otherwise recurse without limit.
  it("defaults maxSubWorkflowDepth to 10", () => {
    expect(loadEngineConfig(baseEnv).maxSubWorkflowDepth).toBe(10);
  });

  it("accepts a maxSubWorkflowDepth override", () => {
    expect(loadEngineConfig({ ...baseEnv, WFE_MAX_SUBWORKFLOW_DEPTH: "3" }).maxSubWorkflowDepth).toBe(3);
  });

  it("accepts 0 as a maxSubWorkflowDepth override (no nested sub-workflows at all)", () => {
    expect(loadEngineConfig({ ...baseEnv, WFE_MAX_SUBWORKFLOW_DEPTH: "0" }).maxSubWorkflowDepth).toBe(0);
  });

  it("rejects a negative maxSubWorkflowDepth at boot time", () => {
    expect(() => loadEngineConfig({ ...baseEnv, WFE_MAX_SUBWORKFLOW_DEPTH: "-1" })).toThrow(
      /WFE_MAX_SUBWORKFLOW_DEPTH/
    );
  });

  it("rejects a non-integer maxSubWorkflowDepth at boot time", () => {
    expect(() => loadEngineConfig({ ...baseEnv, WFE_MAX_SUBWORKFLOW_DEPTH: "1.5" })).toThrow(
      /WFE_MAX_SUBWORKFLOW_DEPTH/
    );
  });

  it("rejects a non-numeric maxSubWorkflowDepth at boot time", () => {
    expect(() => loadEngineConfig({ ...baseEnv, WFE_MAX_SUBWORKFLOW_DEPTH: "many" })).toThrow(
      /WFE_MAX_SUBWORKFLOW_DEPTH/
    );
  });
});
