import { defineConfig, devices } from '@playwright/test';

/**
 * The suite runs against the built single-file artifact, not the dev server,
 * so what is tested is what ships.
 *
 * Chromium comes from the image's pre-installed Playwright browsers when
 * `PLAYWRIGHT_CHROMIUM_PATH` is set; otherwise Playwright's own download is
 * used. The real-model spec is excluded by default (SPEC §9.2) because it needs
 * a working WebGPU device and several minutes of download.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: process.env.REAL_MODEL ? [] : ['**/real-model.spec.js'],
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
      testIgnore: ['**/mobile.spec.js'],
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
