/**
 * Phone-viewport suite (SPEC §2.2, §8, §9.2 scenario 6).
 *
 * Responsive layout is a requirement rather than a nicety, so these assert
 * usability properties — nothing overflows the viewport, touch targets are big
 * enough, the confirmation card is reachable — not just that elements exist.
 *
 * Runs under the `mobile-chromium` project (Pixel 7 device profile).
 *
 * @module tests/e2e/mobile.spec
 */

import { expect, send, settled, test, toolCall } from './fixtures.js';

/** Apple's and Google's guidance converge on ~44-48 CSS px for a touch target. */
const MIN_TOUCH_PX = 40;

test('the page never scrolls sideways', async ({ open, page }) => {
  await open(['A reply long enough to wrap on a narrow screen, several times over, without pushing anything off the side of the display.']);
  await send(page, 'hello there');
  await settled(page);

  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.doc).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
});

test('tool round-trip works at a phone size and the card is thumb-friendly', async ({ open, page, target }) => {
  await open([toolCall({ url: `${target.url}/json` }), 'It is 14°C in Bristol.']);
  await send(page, 'weather?');

  const card = page.locator('.confirm-card');
  await expect(card).toBeVisible();

  // The card fits the viewport and its buttons are comfortably tappable.
  const viewport = page.viewportSize();
  const cardBox = await card.boundingBox();
  expect(cardBox.x).toBeGreaterThanOrEqual(0);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width + 1);

  for (const name of ['Approve', 'Deny']) {
    const box = await card.getByRole('button', { name }).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
    expect(box.width).toBeGreaterThanOrEqual(100);
  }

  // The full URL is readable before approving — it wraps rather than truncating.
  await expect(card.locator('.confirm-url')).toContainText('/json');

  await card.getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  expect(target.received()).toHaveLength(1);
  await expect(page.locator('.msg-assistant').last()).toContainText('Bristol');
});

test('settings and log open as full-height sheets over the chat', async ({ open, page }) => {
  await open(['hi']);
  const viewport = page.viewportSize();

  await page.locator('#toggle-settings').click();
  const sheet = page.locator('#settings-sheet');
  await expect(sheet).toHaveAttribute('data-open', 'true');

  // The sheet slides in over 180ms, so poll rather than measuring mid-flight.
  await expect.poll(async () => (await sheet.boundingBox()).x).toBeLessThan(60);
  const box = await sheet.boundingBox();
  expect(box.width).toBeGreaterThan(viewport.width * 0.8);
  expect(box.height).toBeGreaterThan(viewport.height * 0.9);

  // A strip of scrim stays exposed, so tap-outside-to-close actually works.
  await expect(page.locator('#scrim')).toHaveAttribute('data-open', 'true');
  expect(box.x).toBeGreaterThanOrEqual(24);
  await page.locator('#scrim').click({ position: { x: 8, y: 200 } });
  await expect(sheet).toHaveAttribute('data-open', 'false');
});

test('the composer stays reachable and its controls are tappable', async ({ open, page }) => {
  await open(['hi']);
  const viewport = page.viewportSize();

  const sendBox = await page.locator('#send').boundingBox();
  expect(sendBox.height).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
  expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(viewport.height + 1);

  const inputBox = await page.locator('#input').boundingBox();
  expect(inputBox.height).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
});

test('long unbroken content wraps instead of stretching the layout', async ({ open, page, target }) => {
  const long = 'https://example.test/' + 'a'.repeat(300);
  await open([toolCall({ url: long }), 'done']);
  await send(page, 'fetch a very long url');

  await expect(page.locator('.confirm-card')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('a small-memory phone is offered the small model with a reason', async ({ page, appServer }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 4, configurable: true });
  });
  await page.goto(`${appServer.url}/?mockEngine=1`);
  await expect(page.locator('#send')).toBeEnabled({ timeout: 20_000 });

  await expect(page.locator('#messages')).toContainText(/small model is pre-selected/);
  await page.locator('#toggle-settings').click();
  await expect(page.locator('select')).toHaveValue(/1\.7B|0\.6B/);
});

test('the loading card fits a phone and stays on screen', async ({ page, appServer }) => {
  // This whole feature exists because of a failure on a phone, so the phone
  // layout of the thing that reports it is not an afterthought.
  const qs = new URLSearchParams({ mockEngine: '1', mockScript: '["ok"]', mockLoadMs: '8000' });
  await page.goto(`${appServer.url}/?${qs}`);

  const card = page.locator('.loading-card');
  await expect(card).toBeVisible();

  const viewport = page.viewportSize();
  const box = await card.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('the failure report is readable and actionable on a phone', async ({ page, appServer }) => {
  const qs = new URLSearchParams({
    mockEngine: '1', mockScript: '["ok"]', mockLoadMs: '1200', mockLoadFail: 'cache',
  });
  await page.goto(`${appServer.url}/?${qs}`);

  const card = page.locator('.loading-card-failed');
  await expect(card).toBeVisible({ timeout: 20_000 });

  const viewport = page.viewportSize();
  const box = await card.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);

  // Every action stays tappable rather than being squeezed into a row of slivers.
  for (const button of await card.getByRole('button').all()) {
    const b = await button.boundingBox();
    expect(b.height).toBeGreaterThanOrEqual(MIN_TOUCH_PX - 8);
  }

  // The debug block wraps instead of pushing the page sideways.
  await card.locator('.loading-details > summary').click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
