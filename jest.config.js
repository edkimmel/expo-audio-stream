/** Unit tests for the TypeScript bridge layer (src/). Native modules are
 * mocked — see src/__tests__/. Native logic is tested separately: Kotlin via
 * gradle testDebugUnitTest, Swift via tests/ios/ in CI. */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs" } }],
  },
};
