/**
 * Installable app and offline start-up.
 *
 * The promise being tested is a narrow one: once the page has been visited
 * (and a model downloaded — which the mock engine stands in for here), the app
 * starts and chats with no network at all. Web requests still need a
 * connection, and say so plainly when there is none.
 *
 * "No network" is simulated by stopping the server outright as well as
 * switching Playwright offline, so a pass cannot come from the network
 * quietly answering — whatever the offline switch does or does not cover.
 *
 * @module tests/e2e/pwa.spec
 */

import { expect, send, settled, test, toolCall } from './fixtures.js';
import { PWA_FILES, startStaticServer } from './test-server.js';

/** Wait until a service worker controls the page. */
async function waitForController(page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
}

test('the page links a manifest the browser can install from', async ({ open, page, appServer }) => {
  await open(['hi']);

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await page.request.get(new URL(href, `${appServer.url}/`).href)).json();
  expect(manifest).toMatchObject({ name: 'Browser Agent', start_url: './', scope: './', display: 'standalone' });

  // Chrome's install criteria: a 192 and a 512 icon, both actually loadable.
  const sizes = manifest.icons.map((i) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  for (const icon of manifest.icons) {
    const res = await page.request.get(new URL(icon.src, `${appServer.url}/`).href);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
  }
});

test('every file in public/ is one the test server knows how to serve', async () => {
  // The same list lives in ci.yml's build assertion. A file added to public/
  // fails here until it is added to PWA_FILES, which is the prompt to add it
  // to ci.yml (and to SHELL in public/sw.js, if it should work offline).
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const listed = async (dir, prefix = '') => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(...(await listed(join(dir, entry.name), `${prefix}/${entry.name}`)));
      else out.push(`${prefix}/${entry.name}`);
    }
    return out;
  };
  const shipped = (await listed('public')).sort();
  expect(shipped).toEqual(Object.keys(PWA_FILES).sort());
});

test('after one visit, the app starts and chats with the server gone', async ({ open, page, appServer }) => {
  await open(['First reply, online.']);
  await waitForController(page);

  await appServer.stop();
  await page.context().setOffline(true);

  // Same URL, so the mock engine is configured the same way; the script
  // restarts with the fresh page.
  await page.reload();
  await expect(page.locator('#send')).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator('.notice').filter({ hasText: 'This device is offline' })).toBeVisible();

  await send(page, 'hello, offline');
  await settled(page);
  await expect(page.locator('.msg-assistant').last()).toContainText('First reply, online.');
});

test('a web request made offline says "offline", not CORS', async ({ open, page, target }) => {
  await open([toolCall({ url: `${target.url}/json` }), 'I could not reach it — the device is offline.']);
  await page.context().setOffline(true);
  await expect(page.locator('.notice').filter({ hasText: 'This device is offline' })).toBeVisible();

  await send(page, 'fetch it');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  const tool = page.locator('.tool-card').first();
  await expect(tool).toHaveClass(/tool-error/);
  await expect(tool).toContainText('offline');
  await expect(tool).not.toContainText('CORS');

  await page.context().setOffline(false);
  await expect(page.locator('.notice').filter({ hasText: 'Back online' })).toBeVisible();
});

test('the service worker leaves the agent’s own requests alone', async ({ open, page, target }) => {
  await open([toolCall({ url: `${target.url}/json` }), 'It is 14°C in Bristol.']);
  await waitForController(page);

  await send(page, 'weather?');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  expect(target.received()).toHaveLength(1);
  await expect(page.locator('.tool-card').first()).toHaveClass(/tool-good/);

  // Nothing but the shell is in the worker's cache: no approved response.
  const cached = await page.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('browser-agent-shell-')) continue;
      const cache = await caches.open(name);
      out.push(...(await cache.keys()).map((r) => new URL(r.url).pathname));
    }
    return out;
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.every((p) => p === '/' || Object.hasOwn(PWA_FILES, p))).toBe(true);
});

test('the Install button appears only when the browser offers, and replays its prompt', async ({ open, page }) => {
  await open(['hi']);
  const button = page.locator('#install');
  await expect(button).toBeHidden();

  // Headless Chromium never offers to install, so stand in for it.
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    globalThis.__prompted = 0;
    event.prompt = async () => {
      globalThis.__prompted += 1;
    };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    globalThis.dispatchEvent(event);
  });
  await expect(button).toBeVisible();

  await button.click();
  await expect(button).toBeHidden();
  expect(await page.evaluate(() => globalThis.__prompted)).toBe(1);

  await page.evaluate(() => globalThis.dispatchEvent(new Event('appinstalled')));
  await expect(page.locator('.notice').filter({ hasText: 'Installed.' })).toBeVisible();
});

test('index.html still works on a host that serves nothing else', async ({ page }) => {
  const server = await startStaticServer(0, undefined, { pwa: false });
  try {
    const qs = new URLSearchParams({ mockEngine: '1', mockScript: JSON.stringify(['Still here.']) });
    await page.goto(`${server.url}/?${qs}`);
    await expect(page.locator('#send')).toBeEnabled({ timeout: 20_000 });
    await send(page, 'hello');
    await settled(page);
    await expect(page.locator('.msg-assistant').last()).toContainText('Still here.');
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  } finally {
    await server.close();
  }
});
