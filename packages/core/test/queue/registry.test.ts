import { WfeError } from "../../src/errors";
import { MemoryQueueDriver } from "../../src/queue/memory-driver";
import { createQueueDriver, listQueueDrivers, registerQueueDriver } from "../../src/queue/registry";

describe("queue driver registry", () => {
  it("creates a registered driver by name", () => {
    const driver = createQueueDriver("memory", {});
    expect(driver).toBeInstanceOf(MemoryQueueDriver);
    expect(driver.name).toBe("memory");
  });

  it("lists the built-in drivers", () => {
    expect(listQueueDrivers()).toEqual(expect.arrayContaining(["memory"]));
  });

  it("throws an actionable error for an unknown driver", () => {
    expect(() => createQueueDriver("kafka", {})).toThrow(/kafka/);
    expect(() => createQueueDriver("kafka", {})).toThrow(/memory/);
  });

  it("rejects a duplicate registration", () => {
    registerQueueDriver("test.dup", () => new MemoryQueueDriver());
    expect(() => registerQueueDriver("test.dup", () => new MemoryQueueDriver())).toThrow(WfeError);
  });
});
