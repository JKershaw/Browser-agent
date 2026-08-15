import { defineConfig, devices } from '@playwright/test';

/**
 * The suite runs against the built single-file artifact, not the dev server,
 * so what is tested is what ships.
 *
 * Chromium comes from the image's pre-installed Playwright browsers when
 * `PLAYWRIGHT_CHROMIUM_PATH` is set; otherwise Playwright's own download is
 * used.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

/**
 * The real-model spec (SPEC §9.2) needs a working WebGPU device and downloads
 * ~0.4 GB, so it is opt-in via `npm run test:e2e:real`.
 *
 * This list is spread into every project rather than set at the top level: a
 * project's own `testIgnore` *replaces* the global one, so a project that sets
 * it would otherwise silently pick the real-model spec back up.
 */
const OPT_IN_ONLY = process.env.REAL_MODEL ? [] : ['**/real-model.spec.js'];

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath },
      },
      // The phone suite asserts phone-sized layout; running it at 1280px
      // proves nothing and fails on the desktop side rail.
      testIgnore: ['**/mobile.spec.js', ...OPT_IN_ONLY],
    },
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Pixel 7'],
        launchOptions: { executablePath },
      },
      testMatch: ['**/mobile.spec.js'],
    },
  ],
});
