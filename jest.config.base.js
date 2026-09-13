module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/test/**/*.test.ts"],
  setupFiles: ["<rootDir>/../../jest.setup.js"],
  moduleNameMapper: {
    "^@wfe/sdk$": "<rootDir>/../sdk/src",
    "^@wfe/core$": "<rootDir>/../core/src"
  },
  transform: {
    // The examples/sample-plugin/*.ts files are loaded at runtime as raw
    // TypeScript via Node's native type-stripping (they're never compiled to
    // dist/), so their internal relative imports carry an explicit ".ts"
    // extension — required by Node's ESM resolver, but rejected by tsc
    // without allowImportingTsExtensions. That flag only permits the syntax;
    // it doesn't change how any other file in this repo compiles.
    "^.+\\.ts$": ["ts-jest", { tsconfig: { allowImportingTsExtensions: true, noEmit: true } }]
  }
};
