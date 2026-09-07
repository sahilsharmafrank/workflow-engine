import { SDK_NAME } from "../src";

describe("sdk package", () => {
  it("exports its package name", () => {
    expect(SDK_NAME).toBe("@wfe/sdk");
  });
});
