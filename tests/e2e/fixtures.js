/**
 * Shared Playwright fixtures: the static server hosting `dist/index.html`, the
 * CORS-permissive target server the agent calls, and a helper for building the
 * scripted-engine URL.
 *
 * @module tests/e2e/fixtures
 */

import { test as base, expect } from '@playwright/test';
import { startStaticServer, startTargetServer } from './test-server.js';

export const test = base.extend({
  /** The built artifact, served over HTTP. */
  // eslint-disable-next-line no-empty-pattern
  appServer: async ({}, use) => {
    const server = await startStaticServer();
    await use(server);
    await server.close();
  },

  /** The server the agent's curl tool talks to. */
  // eslint-disable-next-line no-empty-pattern
  target: async ({}, use) => {
    const server = await startTargetServer();
    await use(server);
    await server.close();
  },

  /**
   * `open(script, params?)` loads the app with the mock engine driven by
   * `script` — an array of replies, one per generate call.
   */
  open: async ({ page, appServer }, use) => {
    await use(async (script, params = {}) => {
      const qs = new URLSearchParams({
        mockEngine: '1',
        mockScript: JSON.stringify(script),
        ...params,
      });
      await page.goto(`${appServer.url}/?${qs}`);
      await expect(page.locator('#send')).toBeEnabled({ timeout: 20_000 });
      return page;
    });
  },
});

export { expect };

/**
 * Build the fenced JSON tool call a scripted model reply would emit.
 *
 * @param {object} args `{method, url, headers, body}`
 * @param {string} [prose] Optional text before the block.
 * @returns {string}
 */
export function toolCall(args, prose = '') {
  const call = { tool: 'curl', args: { method: 'GET', headers: {}, body: null, ...args } };
  return `${prose}${prose ? '\n' : ''}\`\`\`json\n${JSON.stringify(call)}\n\`\`\``;
}

/**
 * Send a message and wait for the turn to finish.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
export async function send(page, text) {
  await page.locator('#input').fill(text);
  await page.locator('#send').click();
}

/**
 * Wait until no turn is running (the Stop button is hidden again).
 * @param {import('@playwright/test').Page} page
 */
export async function settled(page) {
  await expect(page.locator('#stop')).toBeHidden({ timeout: 30_000 });
}
