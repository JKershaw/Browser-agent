import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Everything except the DOM layer, which the Playwright suite covers.
      include: ['src/**/*.js'],
      // The DOM layer is covered by the Playwright suite instead: asserting on
      // rendered markup in jsdom would test a simulation, not the artifact.
      exclude: ['src/ui/**', 'src/main.js', 'src/debug.js'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
