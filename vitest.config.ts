import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The plugin entry is composition only: it constructs the modules below
      // and hands them the live ctx. There is nothing to assert about it that
      // the module tests do not already cover, and faking a whole harness
      // context would test the fake. It is verified by loading it in a profile.
      exclude: ['src/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
