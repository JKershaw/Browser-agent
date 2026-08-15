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
        // Global *and* per-file. A global-only gate let app.js — the one place
        // where every setting meets the tool — sit at 48% branch coverage
        // while passing comfortably behind toolcall.js's 99%.
        perFile: true,
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
