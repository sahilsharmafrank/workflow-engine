/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  setupFiles: ["<rootDir>/../../jest.setup.js"],
  moduleNameMapper: {
    "^@wfe/sdk$": "<rootDir>/../sdk/dist",
    "^@wfe/sdk/(.*)$": "<rootDir>/../sdk/dist/$1",
  },
  transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }] },
};
