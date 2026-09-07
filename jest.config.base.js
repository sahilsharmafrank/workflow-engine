module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/test/**/*.test.ts"],
  moduleNameMapper: {
    "^@wfe/sdk$": "<rootDir>/../sdk/src",
    "^@wfe/core$": "<rootDir>/../core/src"
  }
};
