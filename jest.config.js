// Root Jest config.
//
// Pure-TS unit tests transpiled with ts-jest (transpile-only). We deliberately
// avoid the expo-module-scripts babel preset: it pulls in babel-preset-expo,
// which requires `expo/config` — and `expo` is only a peer dependency, present
// in the example app but not at the library root. ts-jest needs no expo runtime.
const tsJest = ['ts-jest', { diagnostics: false }]

const common = {
  testEnvironment: 'node',
  rootDir: __dirname,
  transform: { '^.+\\.tsx?$': tsJest },
  testMatch: ['**/__tests__/**/*.(test|spec).ts'],
}

module.exports = {
  projects: [
    { ...common, displayName: 'src', roots: ['<rootDir>/src'] },
    { ...common, displayName: 'plugin', roots: ['<rootDir>/plugin/src'] },
  ],
}
